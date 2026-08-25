import { describe, expect, it, vi } from 'vitest';

vi.mock('$app/server', async () => {
	const { mockGetRequestEvent } = await import('../test/route-context.js');
	return mockGetRequestEvent();
});

import {
	call,
	createRouteContext,
	type RouteTestContext
} from '../test/route-context';
import { login } from '../test/helpers';

const createSession = async (
	ctx: RouteTestContext,
	body: Record<string, unknown>
) => {
	const { POST } = await import('../../../routes/api/uploads/+server.js');
	const response = await call(
		POST,
		ctx.event({
			method: 'POST',
			path: '/api/uploads',
			body: JSON.stringify(body),
			headers: { 'content-type': 'application/json' }
		})
	);
	if (response.status !== 201) {
		throw new Error(`Create failed: ${response.status} ${await response.text()}`);
	}
	return (await response.json()) as {
		sessionId: string;
		fileId: string;
		partSize: number;
		partCount: number;
	};
};

const uploadPart = async (
	ctx: RouteTestContext,
	sessionId: string,
	partNumber: number,
	body: string
) => {
	const { PUT } = await import(
		'../../../routes/api/uploads/[id]/parts/[part]/+server.js'
	);
	return call(
		PUT,
		ctx.event({
			method: 'PUT',
			path: `/api/uploads/${sessionId}/parts/${partNumber}`,
			body,
			headers: { 'content-type': 'application/octet-stream' },
			params: { id: sessionId, part: String(partNumber) }
		})
	);
};

const complete = async (ctx: RouteTestContext, sessionId: string) => {
	const { POST } = await import(
		'../../../routes/api/uploads/[id]/complete/+server.js'
	);
	return call(
		POST,
		ctx.event({
			method: 'POST',
			path: `/api/uploads/${sessionId}/complete`,
			params: { id: sessionId }
		})
	);
};

describe('staged/resumable upload (local platform)', () => {
	let shared: RouteTestContext | undefined;
	const setup = async () => (shared ??= await createRouteContext());

	it('finalizes a staged upload into a normal, servable file', async () => {
		const ctx = await setup();
		await login(ctx);
		const payload = 'hello staged world';
		const session = await createSession(ctx, {
			name: 'staged.txt',
			sizeBytes: payload.length,
			contentType: 'text/plain',
			public: true
		});
		expect(session.partCount).toBe(1);

		const part = await uploadPart(ctx, session.sessionId, 1, payload);
		expect(part.status).toBe(201);

		const finished = await complete(ctx, session.sessionId);
		expect(finished.status).toBe(201);
		const body = (await finished.json()) as {
			file: { id: string; sizeBytes: number; public: boolean };
		};
		expect(body.file.id).toBe(session.fileId);
		expect(body.file.sizeBytes).toBe(payload.length);
		await ctx.drainWaitUntil();

		const { GET } = await import('../../../routes/f/[id]/+server.js');
		const served = await call(
			GET,
			ctx.event({ path: `/f/${session.fileId}`, params: { id: session.fileId } })
		);
		expect(served.status).toBe(200);
		expect(await served.text()).toBe(payload);
	});

	it('rejects completion before every part is uploaded', async () => {
		const ctx = await setup();
		await login(ctx);
		const session = await createSession(ctx, {
			name: 'incomplete.bin',
			sizeBytes: 24,
			contentType: 'application/octet-stream'
		});
		await expect(complete(ctx, session.sessionId)).rejects.toMatchObject({
			status: 409
		});
	});

	it('aborts a staged upload and refuses later completion', async () => {
		const ctx = await setup();
		await login(ctx);
		const session = await createSession(ctx, {
			name: 'doomed.bin',
			sizeBytes: 10,
			contentType: 'application/octet-stream'
		});
		const { DELETE } = await import('../../../routes/api/uploads/[id]/+server.js');
		const aborted = await call(
			DELETE,
			ctx.event({
				method: 'DELETE',
				path: `/api/uploads/${session.sessionId}`,
				params: { id: session.sessionId }
			})
		);
		expect(aborted.status).toBe(204);
		await expect(complete(ctx, session.sessionId)).rejects.toMatchObject({
			status: 409
		});
	});
});
