import type { RequestHandler } from './$types';
import { Effect } from 'effect';
import {
	SESSION_COOKIE,
	STATE_COOKIE,
	sessionCookieOptions
} from '$lib/server/auth-policy';
import { runEdge } from '$lib/server/edge';
import { InvalidRequest } from '$lib/server/errors';
import { Auth } from '$lib/server/services/auth';

const redirectHome = () =>
	new Response(null, {
		status: 302,
		headers: { 'Cache-Control': 'private, no-store', Location: '/' }
	});

export const GET: RequestHandler = ({ cookies, url }) =>
	runEdge(
		Effect.gen(function* () {
			const auth = yield* Auth;
			const state = url.searchParams.get('state');
			const expectedState = cookies.get(STATE_COOKIE);
			cookies.delete(STATE_COOKIE, { path: '/' });
			if (!state || !expectedState || state !== expectedState) {
				return yield* new InvalidRequest({
					status: 400,
					message: 'Sign-in state did not match; start again'
				});
			}
			const code = url.searchParams.get('code');
			if (!code) {
				return yield* new InvalidRequest({
					status: 400,
					message: 'Sign-in did not return an authorization code'
				});
			}
			const { sealedSession } = yield* auth.completeSignIn(code);
			cookies.set(SESSION_COOKIE, sealedSession, sessionCookieOptions);
			return redirectHome();
		})
	);
