import type { RequestHandler } from './$types';
import { Effect } from 'effect';
import { cookieNames } from '$lib/server/auth-policy';
import { AppConfig } from '$lib/server/config';
import { runEdge } from '$lib/server/edge';
import { InvalidRequest } from '$lib/server/errors';
import { Auth } from '$lib/server/services/auth';

// A POST from the dashboard's own form, so a cross-site link cannot sign
// someone out. Clears the cookie, then hands off to WorkOS to end the
// session there and bounce back home.
export const POST: RequestHandler = ({ cookies, request, url }) =>
	runEdge(
		Effect.gen(function* () {
			if (request.headers.get('origin') !== url.origin) {
				return yield* new InvalidRequest({
					status: 403,
					message: 'The request origin is not allowed'
				});
			}
			const auth = yield* Auth;
			const config = yield* AppConfig;
			const names = cookieNames(config.dashboardOrigin);
			const location = yield* auth.logoutUrl(
				cookies.get(names.session),
				`${config.dashboardOrigin}/`
			);
			cookies.delete(names.session, { path: '/', secure: names.secure });
			return new Response(null, {
				status: 303,
				headers: { 'Cache-Control': 'private, no-store', Location: location }
			});
		})
	);
