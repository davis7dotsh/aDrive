import { Effect, Schema } from 'effect';
import { FileListResponseSchema, type FileListResponse } from '@adrive/shared';
import { SESSION_COOKIE } from '../auth-policy';
import { call, type RouteTestContext } from './route-context';

export interface TestIdentity {
	readonly userId: string;
	readonly orgId?: string;
}

// Signs the cookie jar in through the WorkOS fake: the fake accepts
// `fake:<userId>:<orgId>` as an authorization code, and the callback
// bootstraps the tenant rows exactly as a real first sign-in would. With
// no org given, the callback creates a personal org for the user, so
// repeated logins as the same user land in the same org.
export const loginAs = async (
	ctx: RouteTestContext,
	identity: TestIdentity
) => {
	const { fakeSession } = await import('../services/workos');
	const { STATE_COOKIE } = await import('../auth-policy');
	const { GET } = await import('../../../routes/auth/callback/+server.js');
	ctx.cookies.delete(SESSION_COOKIE);
	ctx.cookies.set(STATE_COOKIE, 'state=test-state');
	const code = fakeSession(identity.userId, identity.orgId ?? null);
	const response = await call(
		GET,
		ctx.event({
			path: `/auth/callback?code=${encodeURIComponent(code)}&state=test-state`
		})
	);
	if (response.status !== 302) {
		throw new Error(`Login failed: ${response.status}`);
	}
	const cookie = ctx.cookies.get(SESSION_COOKIE);
	if (!cookie) throw new Error('Login did not set the session cookie');
	return cookie;
};

export const TEST_LOGIN: TestIdentity = { userId: 'user_test' };

// Login is idempotent: the cookie jar keeps the session across tests.
export const login = async (ctx: RouteTestContext) => {
	if (ctx.cookies.get(SESSION_COOKIE)) return;
	await loginAs(ctx, TEST_LOGIN);
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

// The content origin of the org the cookie jar is signed in to.
export const currentContentOrigin = async (ctx: RouteTestContext) => {
	const { contentOrigin } = await import('./route-context');
	return contentOrigin((await currentIdentity(ctx)).orgSlug);
};

// The current cookie's identity, as the hook would resolve it.
export const currentIdentity = async (ctx: RouteTestContext) => {
	const { resolveEventAuth } = await import('../request-auth');
	const resolved = await resolveEventAuth(
		ctx.env,
		ctx.event({ path: '/api/auth/check' })
	);
	if (!resolved.auth) throw new Error('No session in the cookie jar');
	return resolved.auth;
};

export const indexFile = async (ctx: RouteTestContext, fileId: string) => {
	const { runWorkerProgram } = await import('$lib/server/edge');
	const { Indexing } = await import('$lib/server/services/indexing');
	const identity = await currentIdentity(ctx);
	await runWorkerProgram(
		ctx.env,
		Effect.gen(function* () {
			const indexing = yield* Indexing;
			yield* indexing.process(fileId);
		}),
		identity
	);
};
