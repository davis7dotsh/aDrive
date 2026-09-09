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
import { currentIdentity, loginAs, uploadFile } from '../test/helpers';

describe('rate limits (local platform)', () => {
	let shared: RouteTestContext | undefined;
	const setup = async () => {
		shared ??= await createRouteContext();
		shared.deniedRateLimits.clear();
		return shared;
	};

	it('refuses uploads, device auth, and anonymous fetches once their limit is hit', async () => {
		const ctx = await setup();
		await loginAs(ctx, { userId: 'user_rate_limited' });
		const file = await uploadFile(ctx, { name: 'limited.txt' });

		ctx.deniedRateLimits.add('upload');
		const { PUT } = await import('../../../routes/api/files/+server.js');
		const refused = await call(
			PUT,
			ctx.event({
				method: 'PUT',
				path: '/api/files',
				body: 'more',
				headers: {
					'content-type': 'text/plain',
					'x-adrive-file-name': 'more.txt'
				}
			})
		);
		expect(refused.status).toBe(429);
		expect(refused.headers.get('retry-after')).toBe('60');
		const { POST: createSession } =
			await import('../../../routes/api/sites/sessions/+server.js');
		expect(
			(
				await call(
					createSession,
					ctx.event({
						method: 'POST',
						path: '/api/sites/sessions',
						body: JSON.stringify({ displayName: 'x', assets: [] }),
						headers: { 'content-type': 'application/json' }
					})
				)
			).status
		).toBe(429);
		ctx.deniedRateLimits.delete('upload');
		await uploadFile(ctx, { name: 'allowed-again.txt' });

		ctx.deniedRateLimits.add('auth');
		const { POST: devicePOST } =
			await import('../../../routes/api/auth/device/+server.js');
		expect(
			(
				await call(
					devicePOST,
					ctx.event({
						method: 'POST',
						path: '/api/auth/device',
						body: JSON.stringify({ name: 'cli' }),
						headers: { 'content-type': 'application/json' }
					})
				)
			).status
		).toBe(429);
		ctx.deniedRateLimits.delete('auth');

		// Anonymous fetches are counted only past the edge cache; a small
		// public file is served from R2 here, so the miss is refused.
		const { orgSlug } = await currentIdentity(ctx);
		const { GET: serveGET } = await import('../../../routes/f/[id]/+server.js');
		ctx.deniedRateLimits.add('anonymous');
		const denied = await call(
			serveGET,
			await ctx.contentEvent({
				slug: orgSlug,
				path: `/f/${file.id}`,
				params: { id: file.id }
			})
		);
		expect(denied.status).toBe(429);
		ctx.deniedRateLimits.delete('anonymous');
		const served = await call(
			serveGET,
			await ctx.contentEvent({
				slug: orgSlug,
				path: `/f/${file.id}`,
				params: { id: file.id }
			})
		);
		expect(served.status).toBe(200);
	});
});
