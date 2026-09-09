import type { LayoutServerLoad } from './$types';
import { isAdmin } from '$lib/server/request-auth';
import { configFromEnv } from '$lib/server/config';

// The handle hook already resolved the session; expose only what the
// shell renders so the sealed cookie and ids never reach the client.
export const load: LayoutServerLoad = ({
	locals,
	platform,
	setHeaders,
	url
}) => {
	setHeaders({ 'Cache-Control': 'private, no-store' });
	const auth = locals.auth;
	const adminUserIds = platform
		? configFromEnv(platform.env).adminUserIds
		: new Set<string>();
	return {
		session:
			auth && auth.via === 'session'
				? {
						user: { email: auth.email, admin: isAdmin(auth, adminUserIds) },
						role: auth.role,
						org: { name: auth.orgName, slug: auth.orgSlug }
					}
				: null,
		origin: url.origin
	};
};
