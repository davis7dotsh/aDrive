import type { RequestHandler } from './$types';
import { Effect } from 'effect';
import { deviceApprovalParams } from '$lib/device-approval';
import { cookieNames, stateCookieOptions } from '$lib/server/auth-policy';
import { AppConfig } from '$lib/server/config';
import { runEdge } from '$lib/server/edge';
import { WorkOSClient } from '$lib/server/services/workos';

const randomState = () => {
	const bytes = new Uint8Array(16);
	crypto.getRandomValues(bytes);
	return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join(
		''
	);
};

// Starts the AuthKit flow. The state travels in a short-lived cookie so
// the callback can tell this browser's sign-in from a forged redirect.
export const GET: RequestHandler = ({ cookies, url }) =>
	runEdge(
		Effect.gen(function* () {
			const config = yield* AppConfig;
			const workos = yield* WorkOSClient;
			const state = randomState();
			const pending = deviceApprovalParams(url.searchParams);
			pending.set('state', state);
			const names = cookieNames(config.dashboardOrigin);
			cookies.set(
				names.state,
				pending.toString(),
				stateCookieOptions(names.secure)
			);
			return new Response(null, {
				status: 302,
				headers: {
					'Cache-Control': 'private, no-store',
					Location: workos.authorizationUrl(
						state,
						`${config.dashboardOrigin}/auth/callback`
					)
				}
			});
		})
	);
