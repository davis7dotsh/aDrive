import { PasscodeLoginSchema } from '@adrive/shared';
import type { RequestHandler } from './$types';
import { Effect } from 'effect';
import {
	SESSION_COOKIE,
	SESSION_MAX_AGE_SECONDS
} from '$lib/server/auth-policy';
import { authRateLimitResponse } from '$lib/server/auth-rate-limit-response';
import { runEdge } from '$lib/server/edge';
import { InvalidRequest, Unauthorized } from '$lib/server/errors';
import { decodeJson } from '$lib/server/request-json';
import { Auth } from '$lib/server/services/auth';
import { AuthGuard } from '$lib/server/services/auth-guard';

export const POST: RequestHandler = ({
	cookies,
	request,
	url,
	getClientAddress
}) =>
	runEdge(
		Effect.gen(function* () {
			if (request.headers.get('origin') !== url.origin) {
				return yield* new InvalidRequest({
					status: 403,
					message: 'The request origin is not allowed'
				});
			}
			const auth = yield* Auth;
			const authGuard = yield* AuthGuard;
			const clientId = getClientAddress();
			const lock = yield* authGuard.checkPasscodeLock(clientId);
			if (!lock.allowed) return authRateLimitResponse(lock);
			const rateLimit = yield* authGuard.consume('passcodeLogin', clientId);
			if (!rateLimit.allowed) return authRateLimitResponse(rateLimit);
			const input = yield* decodeJson(
				request,
				PasscodeLoginSchema,
				'A passcode is required'
			);
			const outcome = yield* auth.createSession(input.passcode).pipe(
				Effect.matchEffect({
					onFailure: (failure) =>
						failure instanceof Unauthorized
							? authGuard
									.recordPasscodeFailure(clientId)
									.pipe(
										Effect.flatMap((decision) =>
											decision.allowed
												? Effect.fail(failure)
												: Effect.succeed(authRateLimitResponse(decision))
										)
									)
							: Effect.fail(failure),
					onSuccess: (token) =>
						authGuard
							.clearPasscodeFailures(clientId)
							.pipe(Effect.map(() => token))
				})
			);
			if (outcome instanceof Response) return outcome;
			cookies.set(SESSION_COOKIE, outcome, {
				path: '/',
				httpOnly: true,
				secure: true,
				sameSite: 'strict',
				maxAge: SESSION_MAX_AGE_SECONDS
			});
			return Response.json({ ok: true as const });
		})
	);

export const DELETE: RequestHandler = ({ cookies, request, url }) =>
	runEdge(
		Effect.gen(function* () {
			if (request.headers.get('origin') !== url.origin) {
				return yield* new InvalidRequest({
					status: 403,
					message: 'The request origin is not allowed'
				});
			}
			const auth = yield* Auth;
			yield* auth.revokeSession(cookies.get(SESSION_COOKIE));
			cookies.delete(SESSION_COOKIE, { path: '/' });
			return new Response(null, { status: 204 });
		})
	);
