import type { Handle } from '@sveltejs/kit';
import { SESSION_COOKIE, sessionCookieOptions } from '$lib/server/auth-policy';
import { resolveContentHost } from '$lib/server/content-host';
import { MisdirectedRequest } from '$lib/server/errors';
import { assertHostRoute, normalizeOrigins } from '$lib/server/host-gate';
import { resolveEventAuth } from '$lib/server/request-auth';
import { applySecurityHeaders } from '$lib/server/security-headers';

const unavailable = (cause: unknown) => {
	console.error(
		JSON.stringify({
			message: 'request identity could not be resolved',
			cause: String(cause)
		})
	);
	return new Response('Storage unavailable', { status: 502 });
};

export const handle: Handle = async ({ event, resolve }) => {
	const env = event.platform?.env;
	if (!env) throw new Error('Cloudflare bindings unavailable');

	const originConfig = {
		dashboardOrigin: env.DASHBOARD_ORIGIN,
		contentDomain: env.CONTENT_DOMAIN
	};

	let hostRoute;
	try {
		hostRoute = assertHostRoute(event.url, originConfig);
	} catch (cause) {
		if (cause instanceof MisdirectedRequest) {
			return new Response(cause.message, { status: 421 });
		}
		throw cause;
	}

	const origins = normalizeOrigins(originConfig);
	event.locals.auth = null;
	event.locals.content = null;
	if (hostRoute.route === 'content') {
		// The host names the org. A slug nobody owns, or one whose org is
		// suspended, is a 404 for every path so the host leaks nothing.
		let resolved;
		try {
			resolved = await resolveContentHost(env, hostRoute.slug);
		} catch (cause) {
			return unavailable(cause);
		}
		if (resolved._tag === 'Missing') {
			return new Response('Not found', { status: 404 });
		}
		if (resolved._tag === 'Moved') {
			const location = new URL(event.url);
			location.host = `${resolved.slug}.${origins.contentDomain}`;
			return new Response(null, {
				status: 301,
				headers: {
					Location: location.href,
					'Cache-Control': 'public, max-age=300'
				}
			});
		}
		event.locals.content = resolved.host;
	} else {
		try {
			const resolved = await resolveEventAuth(env, event);
			event.locals.auth = resolved.auth;
			if (resolved.refreshedSession !== null) {
				event.cookies.set(
					SESSION_COOKIE,
					resolved.refreshedSession,
					sessionCookieOptions
				);
			}
		} catch (cause) {
			return unavailable(cause);
		}
	}

	return applySecurityHeaders(await resolve(event), {
		pathname: event.url.pathname,
		requestOrigin: event.url.origin,
		contentDomain: origins.contentDomain,
		contentScheme: origins.contentScheme
	});
};
