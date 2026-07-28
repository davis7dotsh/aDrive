import { PasscodeLoginSchema } from '@adrive/shared';
import type { RequestHandler } from './$types';
import { Effect } from 'effect';
import { clearSessionCookie, sessionCookie } from '$lib/server/auth-policy';
import { runEdge } from '$lib/server/edge';
import { InvalidRequest } from '$lib/server/errors';
import { decodeJson } from '$lib/server/request-json';
import { Auth } from '$lib/server/services/auth';

export const POST: RequestHandler = ({ request, url }) =>
	runEdge(
		Effect.gen(function* () {
			if (request.headers.get('origin') !== url.origin) {
				return yield* new InvalidRequest({
					status: 403,
					message: 'The request origin is not allowed'
				});
			}
			const auth = yield* Auth;
			const input = yield* decodeJson(
				request,
				PasscodeLoginSchema,
				'A passcode is required'
			);
			const token = yield* auth.createSession(input.passcode);
			return Response.json(
				{ ok: true as const },
				{ headers: { 'Set-Cookie': sessionCookie(token) } }
			);
		})
	);

export const DELETE: RequestHandler = ({ request, url }) =>
	runEdge(
		Effect.gen(function* () {
			if (request.headers.get('origin') !== url.origin) {
				return yield* new InvalidRequest({
					status: 403,
					message: 'The request origin is not allowed'
				});
			}
			const auth = yield* Auth;
			yield* auth.revokeSession(request.headers.get('cookie'));
			return new Response(null, {
				status: 204,
				headers: { 'Set-Cookie': clearSessionCookie() }
			});
		})
	);
