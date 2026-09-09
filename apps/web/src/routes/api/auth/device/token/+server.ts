import { DeviceTokenRequestSchema } from '@adrive/shared';
import type { RequestHandler } from './$types';
import { Effect } from 'effect';
import { rateLimitResponse } from '$lib/server/auth-rate-limit-response';
import { runEdge } from '$lib/server/edge';
import { decodeJson } from '$lib/server/request-json';
import { Auth } from '$lib/server/services/auth';
import { RateLimits } from '$lib/server/services/rate-limits';

export const POST: RequestHandler = ({ request, getClientAddress }) =>
	runEdge(
		Effect.gen(function* () {
			const auth = yield* Auth;
			const rateLimits = yield* RateLimits;
			const rateLimit = yield* rateLimits.auth(getClientAddress());
			if (!rateLimit.allowed) {
				return rateLimitResponse(
					'Too many authentication requests. Try again later.'
				);
			}
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
