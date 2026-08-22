import { Effect, Schema } from 'effect';
import { FileListResponseSchema, type FileListResponse } from '@adrive/shared';
import { call, type RouteTestContext } from './route-context';

// Use the real local dev passcode when present, otherwise the isolated
// route context supplies a safe test-only fallback for clean checkouts.
const passcode = (ctx: RouteTestContext) => {
	const value = ctx.env.PASSCODE;
	if (!value) throw new Error('PASSCODE missing from platform proxy env');
	return value;
};

// Login is idempotent: the cookie jar keeps the session across tests, so
// repeated logins (which would trip the KV passcode rate limiter) never
// happen.
export const login = async (ctx: RouteTestContext) => {
	if (ctx.cookies.get('__Host-adrive-session')) return;
	const { POST } = await import('../../../routes/api/auth/session/+server.js');
	const response = await call(
		POST,
		ctx.event({
			method: 'POST',
			path: '/api/auth/session',
			body: JSON.stringify({ passcode: passcode(ctx) }),
			headers: { 'content-type': 'application/json' }
		})
	);
	if (response.status !== 200) {
		throw new Error(`Login failed: ${response.status}`);
	}
};

export const listFiles = async (
	ctx: RouteTestContext
): Promise<FileListResponse> => {
	const { GET } = await import('../../../routes/api/files/+server.js');
	const response = await call(GET, ctx.event({ path: '/api/files' }));
	if (!response.ok) throw new Error(`List failed: ${response.status}`);
	return await Schema.decodeUnknownPromise(FileListResponseSchema)(
		await response.json()
	);
};

export const uploadFile = async (
	ctx: RouteTestContext,
	input: {
		name: string;
		content?: string;
		contentType?: string;
		isPublic?: boolean;
		tags?: ReadonlyArray<string>;
	}
) => {
	const content = input.content ?? `contents of ${input.name}`;
	const { PUT } = await import('../../../routes/api/files/+server.js');
	const response = await call(
		PUT,
		ctx.event({
			method: 'PUT',
			path: '/api/files',
			body: content,
			headers: {
				'content-type': input.contentType ?? 'text/plain',
				'x-adrive-file-name': encodeURIComponent(input.name),
				'x-adrive-public': String(input.isPublic ?? true),
				...(input.tags && input.tags.length > 0
					? {
							'x-adrive-tags': encodeURIComponent(JSON.stringify(input.tags))
						}
					: {})
			}
		})
	);
	if (response.status !== 201) {
		throw new Error(
			`Upload failed: ${response.status} ${await response.text()}`
		);
	}
	const body = (await response.json()) as {
		file: { id: string; version: number };
	};
	return body.file;
};

export const mutateFile = async (
	ctx: RouteTestContext,
	id: string,
	mutation: Record<string, unknown>
) => {
	const { PATCH } = await import('../../../routes/api/files/[id]/+server.js');
	const response = await call(
		PATCH,
		ctx.event({
			method: 'PATCH',
			path: `/api/files/${id}`,
			body: JSON.stringify(mutation),
			headers: { 'content-type': 'application/json' },
			params: { id }
		})
	);
	if (!response.ok) {
		throw new Error(
			`Mutation failed: ${response.status} ${await response.text()}`
		);
	}
	return (await response.json()) as { file: { id: string } };
};

export const indexFile = async (ctx: RouteTestContext, fileId: string) => {
	const { runWorkerProgram } = await import('$lib/server/edge');
	const { Indexing } = await import('$lib/server/services/indexing');
	await runWorkerProgram(
		ctx.env,
		Effect.gen(function* () {
			const indexing = yield* Indexing;
			yield* indexing.process(fileId);
		})
	);
};
