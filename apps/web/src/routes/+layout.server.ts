import type { LayoutServerLoad } from './$types';

export const load: LayoutServerLoad = async ({ fetch, setHeaders, url }) => {
	setHeaders({ 'Cache-Control': 'private, no-store' });
	let response: Response;
	try {
		response = await fetch('/api/auth/check');
	} catch {
		return {
			browserSession: false,
			authError: 'Could not restore the session',
			origin: url.origin
		};
	}
	if (response.ok) {
		return { browserSession: true, authError: '', origin: url.origin };
	}
	if (response.status === 401) {
		return { browserSession: false, authError: '', origin: url.origin };
	}
	return {
		browserSession: false,
		authError: `Could not restore the session (${response.status})`,
		origin: url.origin
	};
};
