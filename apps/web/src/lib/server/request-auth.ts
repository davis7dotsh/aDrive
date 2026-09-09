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
import type { AuthContext, ResolvedCredential } from './identity';
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

// Operator routes (/admin, /api/admin/*): a signed-in browser session
// whose WorkOS user id is listed in ADMIN_USER_IDS. API keys never
// qualify, so a leaked key cannot reach the kill switch.
export const isAdmin = (
	auth: Pick<AuthContext, 'userId' | 'via'>,
	adminUserIds: ReadonlySet<string>
) => auth.via === 'session' && adminUserIds.has(auth.userId);

export const requireAdmin = (event: AuthEvent) =>
	Effect.gen(function* () {
		const auth = yield* requireAuth(event);
		const config = yield* AppConfig;
		if (!isAdmin(auth, config.adminUserIds)) {
			return yield* new InvalidRequest({
				status: 403,
				message: 'Admin access is required'
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

// For changes only an owner may make (billing, the content slug).
export const requireOwner = (event: AuthEvent, action: string) =>
	requireWrite(event).pipe(
		Effect.flatMap((auth) =>
			auth.role === 'owner'
				? Effect.succeed(auth)
				: Effect.fail(
						new InvalidRequest({
							status: 403,
							message: `Only an owner can ${action}`
						})
					)
		)
	);

export interface CredentialInput {
	readonly authorization: string | null;
	readonly sessionCookie: string | undefined;
	readonly method: string;
	readonly origin: string | null;
}

const anonymous: ResolvedCredential = { auth: null, refreshedSession: null };

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
			if (bearer) {
				const resolved = yield* auth.resolveApiKey(bearer);
				return { auth: resolved, refreshedSession: null };
			}
			if (!input.sessionCookie) return anonymous;
			if (
				!allowsCredentialOrigin(
					input.method,
					input.origin,
					config.dashboardOrigin
				)
			) {
				return anonymous;
			}
			return yield* auth.resolveSession(input.sessionCookie);
		}).pipe(Effect.catchTag('Unauthorized', () => Effect.succeed(anonymous)))
	);

// Credentials only mean something on the dashboard origin; content routes
// authorize with signed grants instead and never look at them.
export const resolveEventAuth = (
	env: Env,
	event: Pick<RequestEvent, 'request' | 'cookies' | 'url'>
) =>
	classifyRoute(event.url.pathname) === 'content'
		? Promise.resolve(anonymous)
		: resolveCredential(env, {
				authorization: event.request.headers.get('authorization'),
				sessionCookie: event.cookies.get(SESSION_COOKIE),
				method: event.request.method,
				origin: event.request.headers.get('origin')
			});
