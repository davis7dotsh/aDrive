import type { LayoutServerLoad } from './$types';

// The handle hook already resolved the session; expose only what the
// shell renders so the sealed cookie and ids never reach the client.
export const load: LayoutServerLoad = ({ locals, setHeaders, url }) => {
	setHeaders({ 'Cache-Control': 'private, no-store' });
	const auth = locals.auth;
	return {
		session:
			auth && auth.via === 'session'
				? {
						user: { email: auth.email },
						role: auth.role,
						org: { name: auth.orgName, slug: auth.orgSlug }
					}
				: null,
		origin: url.origin
	};
};
