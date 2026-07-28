import { DeviceTokenRequestSchema } from '@adrive/shared';
import type { RequestHandler } from './$types';
import { Effect } from 'effect';
import { runEdge } from '$lib/server/edge';
import { decodeJson } from '$lib/server/request-json';
import { Auth } from '$lib/server/services/auth';

export const POST: RequestHandler = ({ request }) =>
	runEdge(
		Effect.gen(function* () {
			const auth = yield* Auth;
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
