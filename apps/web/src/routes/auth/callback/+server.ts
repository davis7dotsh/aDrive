import type { RequestHandler } from './$types';
import { Effect } from 'effect';
import { deviceApprovalParams } from '$lib/device-approval';
import { cookieNames, sessionCookieOptions } from '$lib/server/auth-policy';
import { AppConfig } from '$lib/server/config';
import { runEdge } from '$lib/server/edge';
import { InvalidRequest } from '$lib/server/errors';
import { Auth } from '$lib/server/services/auth';

const redirectHome = (params: URLSearchParams) =>
	new Response(null, {
		status: 302,
		headers: {
			'Cache-Control': 'private, no-store',
			Location: `/${params.size ? `?${params}` : ''}`
		}
	});

export const GET: RequestHandler = ({ cookies, url }) =>
	runEdge(
		Effect.gen(function* () {
			const auth = yield* Auth;
			const config = yield* AppConfig;
			const names = cookieNames(config.dashboardOrigin);
			const state = url.searchParams.get('state');
			const pending = new URLSearchParams(cookies.get(names.state) ?? '');
			const expectedState = pending.get('state');
			cookies.delete(names.state, { path: '/', secure: names.secure });
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
			cookies.set(
				names.session,
				sealedSession,
				sessionCookieOptions(names.secure)
			);
			return redirectHome(deviceApprovalParams(pending));
		})
	);
