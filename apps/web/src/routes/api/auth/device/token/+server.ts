import { DeviceTokenRequestSchema } from '@adrive/shared';
import type { RequestHandler } from './$types';
import { Effect } from 'effect';
import { authRateLimitResponse } from '$lib/server/auth-rate-limit-response';
import { runEdge } from '$lib/server/edge';
import { decodeJson } from '$lib/server/request-json';
import { Auth } from '$lib/server/services/auth';
import { AuthGuard } from '$lib/server/services/auth-guard';

export const POST: RequestHandler = ({ request, getClientAddress }) =>
	runEdge(
		Effect.gen(function* () {
			const auth = yield* Auth;
			const authGuard = yield* AuthGuard;
			const rateLimit = yield* authGuard.consume(
				'devicePoll',
				getClientAddress()
			);
			if (!rateLimit.allowed) return authRateLimitResponse(rateLimit);
			const input = yield* decodeJson(
				request,
				DeviceTokenRequestSchema,
				'A device code is required'
			);
			const result = yield* auth.pollDevice(input.deviceCode);
			if (result.status === 'complete') {
				return Response.json({ apiKey: result.apiKey });
			}
			return Response.json(
				{ status: result.status },
				{
					status: result.status === 'slow_down' ? 429 : 202,
					headers: { 'Retry-After': '5' }
				}
			);
		})
	);
