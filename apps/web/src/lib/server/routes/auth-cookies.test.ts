import type { Cookies } from '@sveltejs/kit';
import { Effect } from 'effect';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
	cookieNames,
	SESSION_COOKIE_MAX_AGE_SECONDS,
	STATE_COOKIE_MAX_AGE_SECONDS
} from '../auth-policy';

vi.mock('$app/server', async () => {
	const { mockGetRequestEvent } = await import('../test/route-context.js');
	return mockGetRequestEvent();
});

import {
	call,
	createRouteContext,
	setRequestEvent,
	type RouteTestContext
} from '../test/route-context';

// Use the installed framework's serializer and deletion defaults. The
// ordinary Map-based route jar cannot expose Secure expiry cookies on HTTP.
type CookieRecord = {
	name: string;
	value: string;
	options: Parameters<Cookies['set']>[2];
};
const kitPackage = pathToFileURL(
	createRequire(import.meta.url).resolve('@sveltejs/kit/package.json')
);
const kitCookieUrl = new URL('./src/runtime/server/cookie.js', kitPackage).href;
const {
	get_cookies,
	add_cookies_to_headers
}: {
	get_cookies: (
		request: Request,
		url: URL
	) => {
		cookies: Cookies;
		new_cookies: Map<string, CookieRecord>;
		get_cookie_header: (destination: URL, header: string | null) => string;
		set_trailing_slash: (mode: 'never') => void;
	};
	add_cookies_to_headers: (
		headers: Headers,
		cookies: MapIterator<CookieRecord>
	) => void;
} = await import(/* @vite-ignore */ kitCookieUrl);

const requestWithCookies = (
	ctx: RouteTestContext,
	path: string,
	cookie = '',
	method = 'GET',
	origin: string | null = ctx.env.DASHBOARD_ORIGIN
) => {
	const url = new URL(path, ctx.env.DASHBOARD_ORIGIN);
	const event = ctx.event({
		path,
		url,
		method,
		headers: { cookie, origin: origin ?? '' }
	});
	if (origin === null) event.request.headers.delete('origin');
	const jar = get_cookies(event.request, url);
	jar.set_trailing_slash('never');
	event.cookies = jar.cookies;
	setRequestEvent(event);
	return {
		event,
		header: () => jar.get_cookie_header(url, null),
		serialized: () => {
			const headers = new Headers();
			add_cookies_to_headers(headers, jar.new_cookies.values());
			return headers.getSetCookie();
		}
	};
};

const cookieFor = (values: string[], name: string) => {
	const cookie = values.find((value) => value.startsWith(`${name}=`));
	expect(cookie).toBeDefined();
	return cookie ?? '';
};

const expectAttributes = (cookie: string, secure: boolean, maxAge: number) => {
	expect(cookie).toContain('Path=/');
	expect(cookie).toContain('HttpOnly');
	expect(cookie).toContain('SameSite=Lax');
	expect(cookie).toContain(`Max-Age=${maxAge}`);
	expect(/; Secure(?:;|$)/.test(cookie)).toBe(secure);
	expect(cookie).not.toContain('Domain=');
};

afterEach(() => vi.restoreAllMocks());

describe('browser auth cookie attributes', () => {
	it.each([
		'http://siva.otter-hawksbill.ts.net:5273',
		'https://drive.example.test'
	])(
		'preserves device approval, refreshes, and clears cookies on %s',
		async (dashboardOrigin) => {
			const ctx = await createRouteContext();
			ctx.env.DASHBOARD_ORIGIN = dashboardOrigin;
			const names = cookieNames(dashboardOrigin);
			const { GET: signIn } =
				await import('../../../routes/auth/sign-in/+server.js');
			const { GET: callback } =
				await import('../../../routes/auth/callback/+server.js');
			const { POST: signOut } =
				await import('../../../routes/auth/sign-out/+server.js');
			const { GET: authCheck } =
				await import('../../../routes/api/auth/check/+server.js');
			const start = requestWithCookies(
				ctx,
				'/auth/sign-in?device=abcd-2345&expires=2000000000'
			);
			const redirect = await call(signIn, start.event);
			expectAttributes(
				cookieFor(start.serialized(), names.state),
				names.secure,
				STATE_COOKIE_MAX_AGE_SECONDS
			);
			const callbackUrl = new URL(redirect.headers.get('location') ?? '');
			callbackUrl.searchParams.set('device', 'WXYZ-6789');
			const completed = requestWithCookies(
				ctx,
				`${callbackUrl.pathname}${callbackUrl.search}`,
				start.header()
			);
			const response = await call(callback, completed.event);
			expect(response.headers.get('location')).toBe(
				'/?device=ABCD-2345&expires=2000000000'
			);
			expectAttributes(
				cookieFor(completed.serialized(), names.state),
				names.secure,
				0
			);
			expectAttributes(
				cookieFor(completed.serialized(), names.session),
				names.secure,
				SESSION_COOKIE_MAX_AGE_SECONDS
			);
			const authenticated = requestWithCookies(
				ctx,
				'/api/auth/check',
				completed.header()
			);
			expect((await call(authCheck, authenticated.event)).status).toBe(200);

			const { POST: createKey } =
				await import('../../../routes/api/auth/keys/+server.js');
			for (const origin of [null, 'https://foreign.example']) {
				const mutation = requestWithCookies(
					ctx,
					'/api/auth/keys',
					completed.header(),
					'POST',
					origin
				);
				await expect(call(createKey, mutation.event)).rejects.toMatchObject({
					status: 401
				});
			}

			const { workOSFake } = await import('../services/workos');
			vi.spyOn(workOSFake, 'loadSession').mockImplementationOnce(() =>
				Effect.succeed({ authenticated: false, refreshable: true })
			);
			const refreshed = requestWithCookies(ctx, '/', completed.header());
			const { handle } = await import('../../../hooks.server.js');
			await handle({
				event: refreshed.event,
				resolve: async () => new Response('ok')
			});
			expectAttributes(
				cookieFor(refreshed.serialized(), names.session),
				names.secure,
				SESSION_COOKIE_MAX_AGE_SECONDS
			);

			const logout = requestWithCookies(
				ctx,
				'/auth/sign-out',
				refreshed.header(),
				'POST'
			);
			expect((await call(signOut, logout.event)).status).toBe(303);
			expectAttributes(
				cookieFor(logout.serialized(), names.session),
				names.secure,
				0
			);
			const signedOut = requestWithCookies(
				ctx,
				'/api/auth/check',
				logout.header()
			);
			await expect(call(authCheck, signedOut.event)).rejects.toMatchObject({
				status: 401
			});
		}
	);

	it.each([null, 'https://foreign.example'])(
		'rejects sign-out with Origin %s without clearing the session',
		async (origin) => {
			const ctx = await createRouteContext();
			ctx.env.DASHBOARD_ORIGIN = 'http://siva.otter-hawksbill.ts.net:5273';
			const { POST } = await import('../../../routes/auth/sign-out/+server.js');
			const request = requestWithCookies(
				ctx,
				'/auth/sign-out',
				'adrive-wos=present',
				'POST',
				origin
			);
			await expect(call(POST, request.event)).rejects.toMatchObject({
				status: 403
			});
			expect(request.serialized()).toEqual([]);
		}
	);
});
