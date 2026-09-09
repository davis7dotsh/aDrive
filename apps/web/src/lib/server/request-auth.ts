import type { RequestEvent } from '@sveltejs/kit';
import { Effect } from 'effect';
import {
	allowsCredentialOrigin,
	bearerToken,
	SESSION_COOKIE
} from './auth-policy';
import { AppConfig } from './config';
import { runWorkerProgram } from './edge';
import { InvalidRequest, MisdirectedRequest, Unauthorized } from './errors';
import { classifyRoute } from './host-gate';
import { Auth } from './services/auth';

type AuthEvent = Pick<RequestEvent, 'locals' | 'url'>;

// Routes read the identity the handle hook resolved. The origin check is
// repeated here so a handler reached with a foreign URL (tests, misrouted
// internal fetches) still refuses even though the host gate ran first.
export const requireAuth = (event: AuthEvent) =>
	Effect.gen(function* () {
		const config = yield* AppConfig;
		if (event.url.origin !== config.dashboardOrigin) {
			return yield* new MisdirectedRequest({
				message: 'Credentials are accepted only on the dashboard origin'
			});
		}
		const auth = event.locals.auth;
		if (!auth) {
			return yield* new Unauthorized({
				message: 'A valid credential is required'
			});
		}
		return auth;
	});

// For routes that create, change, or delete data. Read-only API keys are
// authenticated but rejected here with a 403 rather than a 401.
export const requireWrite = (event: AuthEvent) =>
	requireAuth(event).pipe(
		Effect.flatMap((auth) =>
			auth.scope === 'read-write'
				? Effect.succeed(auth)
				: Effect.fail(
						new InvalidRequest({
							status: 403,
							message: 'This API key is read-only'
						})
					)
		)
	);

export interface CredentialInput {
	readonly authorization: string | null;
	readonly sessionToken: string | undefined;
	readonly method: string;
	readonly origin: string | null;
}

// Turns a request's credential into locals.auth. An adr_ bearer key wins
// over a cookie. A cookie on a state-changing request must arrive with the
// dashboard's own Origin header, which the browser sets and a cross-site
// form cannot forge. Anything invalid resolves to null; the route decides
// whether that is a 401.
export const resolveCredential = (env: Env, input: CredentialInput) =>
	runWorkerProgram(
		env,
		Effect.gen(function* () {
			const auth = yield* Auth;
			const config = yield* AppConfig;
			const bearer = bearerToken(input.authorization);
			if (bearer) return yield* auth.resolveApiKey(bearer);
			if (!input.sessionToken) return null;
			if (
				!allowsCredentialOrigin(
					input.method,
					input.origin,
					config.dashboardOrigin
				)
			) {
				return null;
			}
			return yield* auth.resolveSession(input.sessionToken);
		}).pipe(Effect.catchTag('Unauthorized', () => Effect.succeed(null)))
	);

// Credentials only mean something on the dashboard origin; content routes
// authorize with signed grants instead and never look at them.
export const resolveEventAuth = (
	env: Env,
	event: Pick<RequestEvent, 'request' | 'cookies' | 'url'>
) =>
	classifyRoute(event.url.pathname) === 'content'
		? Promise.resolve(null)
		: resolveCredential(env, {
				authorization: event.request.headers.get('authorization'),
				sessionToken: event.cookies.get(SESSION_COOKIE),
				method: event.request.method,
				origin: event.request.headers.get('origin')
			});
