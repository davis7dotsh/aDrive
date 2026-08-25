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
import { login, uploadFile } from '../test/helpers';

const createShare = async (
	ctx: RouteTestContext,
	fileId: string,
	body: Record<string, unknown>
) => {
	const { POST } = await import(
		'../../../routes/api/files/[id]/shares/+server.js'
	);
	const response = await call(
		POST,
		ctx.event({
			method: 'POST',
			path: `/api/files/${fileId}/shares`,
			body: JSON.stringify(body),
			headers: { 'content-type': 'application/json' },
			params: { id: fileId }
		})
	);
	if (response.status !== 201) {
		throw new Error(`Share create failed: ${response.status}`);
	}
	return (await response.json()) as {
		share: { id: string };
		url: string;
	};
};

const serveShare = async (
	ctx: RouteTestContext,
	fileId: string,
	query: string
) => {
	const { GET } = await import('../../../routes/f/[id]/+server.js');
	return call(
		GET,
		ctx.event({ path: `/f/${fileId}${query}`, params: { id: fileId } })
	);
};

const tokenOf = (url: string) => new URL(url).searchParams.get('s') ?? '';

describe('durable private links (local platform)', () => {
	let shared: RouteTestContext | undefined;
	const setup = async () => (shared ??= await createRouteContext());

	it('serves a token-only durable link and stops after revoke', async () => {
		const ctx = await setup();
		await login(ctx);
		const file = await uploadFile(ctx, {
			name: 'durable-open.txt',
			content: 'durable body',
			isPublic: false
		});
		const created = await createShare(ctx, file.id, { expiresInDays: 7 });
		const token = tokenOf(created.url);
		expect(token).not.toBe('');

		const served = await serveShare(ctx, file.id, `?s=${token}`);
		expect(served.status).toBe(200);
		expect(served.headers.get('cache-control')).toBe('private, no-store');
		expect(await served.text()).toBe('durable body');

		const { DELETE } = await import(
			'../../../routes/api/files/[id]/shares/[shareId]/+server.js'
		);
		const revoked = await call(
			DELETE,
			ctx.event({
				method: 'DELETE',
				path: `/api/files/${file.id}/shares/${created.share.id}`,
				params: { id: file.id, shareId: created.share.id }
			})
		);
		expect(revoked.status).toBe(204);

		await expect(
			serveShare(ctx, file.id, `?s=${token}`)
		).rejects.toMatchObject({ status: 404 });
	});

	it('gates a passworded durable link behind the correct password', async () => {
		const ctx = await setup();
		await login(ctx);
		const file = await uploadFile(ctx, {
			name: 'durable-locked.txt',
			content: 'locked body',
			isPublic: false
		});
		const created = await createShare(ctx, file.id, {
			password: 'open-sesame',
			expiresInDays: 7
		});
		const token = tokenOf(created.url);

		// No password: a prompt page, not the bytes.
		const prompt = await serveShare(ctx, file.id, `?s=${token}`);
		expect(prompt.status).toBe(200);
		expect(prompt.headers.get('content-type')).toContain('text/html');
		expect(await prompt.text()).toContain('password');

		// Wrong password: 401 prompt.
		const wrong = await serveShare(
			ctx,
			file.id,
			`?s=${token}&p=${encodeURIComponent('nope')}`
		);
		expect(wrong.status).toBe(401);

		// Correct password: the file bytes.
		const ok = await serveShare(
			ctx,
			file.id,
			`?s=${token}&p=${encodeURIComponent('open-sesame')}`
		);
		expect(ok.status).toBe(200);
		expect(await ok.text()).toBe('locked body');
	});
});
