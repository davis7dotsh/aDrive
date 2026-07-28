import type { Handle } from '@sveltejs/kit';
import { MisdirectedRequest } from '$lib/server/errors';
import { assertHostRoute } from '$lib/server/host-gate';

export const handle: Handle = async ({ event, resolve }) => {
	const env = event.platform?.env;
	if (!env) throw new Error('Cloudflare bindings unavailable');

	try {
		assertHostRoute(event.url, {
			dashboardOrigin: env.DASHBOARD_ORIGIN,
			contentOrigin: env.CONTENT_ORIGIN
		});
	} catch (cause) {
		if (cause instanceof MisdirectedRequest) {
			return new Response(cause.message, { status: 421 });
		}
		throw cause;
	}

	return resolve(event);
};
