import { describe, expect, it, vi } from 'vitest';
import { STATE_COOKIE } from '../auth-policy';

vi.mock('$app/server', async () => {
	const { mockGetRequestEvent } = await import('../test/route-context.js');
	return mockGetRequestEvent();
});

import {
	call,
	createRouteContext,
	type RouteTestContext
} from '../test/route-context';

const startSignIn = async (ctx: RouteTestContext, query: string) => {
	const { GET } = await import('../../../routes/auth/sign-in/+server.js');
	const response = await call(
		GET,
		ctx.event({ path: `/auth/sign-in${query}` })
	);
	expect(response.status).toBe(302);
	return new URL(response.headers.get('location') ?? '');
};

const finishSignIn = async (ctx: RouteTestContext, callback: URL) => {
	const { GET } = await import('../../../routes/auth/callback/+server.js');
	return call(
		GET,
		ctx.event({ path: `${callback.pathname}${callback.search}` })
	);
};

describe('device approval after WorkOS sign-in', () => {
	it('returns to the pending device in the state cookie, then consumes that state', async () => {
		const ctx = await createRouteContext();
		const expires = Math.floor(Date.now() / 1_000) + 600;
		const callback = await startSignIn(
			ctx,
			`?device=ABCD-2345&expires=${expires}`
		);
		// Callback parameters cannot replace the approval bound to this browser.
		callback.searchParams.set('device', 'WXYZ-6789');
		callback.searchParams.set('returnTo', 'https://untrusted.example/');
		const response = await finishSignIn(ctx, callback);
		expect(response.status).toBe(302);
		expect(response.headers.get('location')).toBe(
			`/?device=ABCD-2345&expires=${expires}`
		);
		expect(ctx.cookies.get(STATE_COOKIE)).toBeUndefined();
		await expect(finishSignIn(ctx, callback)).rejects.toMatchObject({
			status: 400
		});
	});

	it.each([
		'?returnTo=https://untrusted.example/',
		'?device=//untrusted.example&expires=123',
		'?expires=123',
		''
	])('returns home without a valid device: %s', async (query) => {
		const ctx = await createRouteContext();
		const response = await finishSignIn(ctx, await startSignIn(ctx, query));
		expect(response.headers.get('location')).toBe('/');
	});

	it('drops invalid expiry while keeping a valid device code', async () => {
		const ctx = await createRouteContext();
		const response = await finishSignIn(
			ctx,
			await startSignIn(ctx, '?device=abcd-2345&expires=Infinity')
		);
		expect(response.headers.get('location')).toBe('/?device=ABCD-2345');
	});

	it('rejects a mismatched state before completing sign-in', async () => {
		const ctx = await createRouteContext();
		const callback = await startSignIn(ctx, '?device=ABCD-2345');
		callback.searchParams.set('state', 'wrong-state');
		await expect(finishSignIn(ctx, callback)).rejects.toMatchObject({
			status: 400
		});
		expect(ctx.cookies.get(STATE_COOKIE)).toBeUndefined();
	});
});
