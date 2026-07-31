import type { Handle } from '@sveltejs/kit';
import { MisdirectedRequest } from '$lib/server/errors';
import { assertHostRoute, normalizeOrigins } from '$lib/server/host-gate';
import { applySecurityHeaders } from '$lib/server/security-headers';

export const handle: Handle = async ({ event, resolve }) => {
	const env = event.platform?.env;
	if (!env) throw new Error('Cloudflare bindings unavailable');

	const originConfig = {
		dashboardOrigin: env.DASHBOARD_ORIGIN,
		contentOrigin: env.CONTENT_ORIGIN
	};

	try {
		assertHostRoute(event.url, originConfig);
	} catch (cause) {
		if (cause instanceof MisdirectedRequest) {
			return new Response(cause.message, { status: 421 });
		}
		throw cause;
	}

	return applySecurityHeaders(await resolve(event), {
		pathname: event.url.pathname,
		requestOrigin: event.url.origin,
		contentOrigin: normalizeOrigins(originConfig).contentOrigin
	});
};
