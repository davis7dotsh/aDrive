import type { RequestHandler } from './$types';
import { Effect } from 'effect';
import { SESSION_COOKIE } from '$lib/server/auth-policy';
import { runEdge } from '$lib/server/edge';
import { requireWrite } from '$lib/server/request-auth';
import { InvalidRequest } from '$lib/server/errors';
import { Auth } from '$lib/server/services/auth';

// Sign out everywhere: drops every dashboard session and cancels any
// in-flight device authorizations. API keys are left alone — revoke
// those individually so a stolen browser session cannot brick the CLI.
export const DELETE: RequestHandler = (event) => {
	const { cookies, request, url } = event;
	return runEdge(
		Effect.gen(function* () {
			if (request.headers.get('origin') !== url.origin) {
				return yield* new InvalidRequest({
					status: 403,
					message: 'The request origin is not allowed'
				});
			}
			const auth = yield* Auth;
			yield* requireWrite(event);
			const revoked = yield* auth.revokeAllSessions;
			cookies.delete(SESSION_COOKIE, { path: '/' });
			return Response.json(
				{ revoked },
				{ headers: { 'Cache-Control': 'private, no-store' } }
			);
		})
	);
};
