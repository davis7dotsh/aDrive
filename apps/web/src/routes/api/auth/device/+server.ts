import { DeviceAuthorizationCreateSchema } from '@adrive/shared';
import type { RequestHandler } from './$types';
import { Effect } from 'effect';
import { AppConfig } from '$lib/server/config';
import { runEdge } from '$lib/server/edge';
import { decodeJson } from '$lib/server/request-json';
import { Auth } from '$lib/server/services/auth';

export const POST: RequestHandler = ({ request }) =>
	runEdge(
		Effect.gen(function* () {
			const auth = yield* Auth;
			const config = yield* AppConfig;
			const input = yield* decodeJson(
				request,
				DeviceAuthorizationCreateSchema,
				'A device name is required'
			);
			const result = yield* auth.createDeviceAuthorization(input.name);
			const verificationUri = `${config.dashboardOrigin}/`;
			return Response.json(
				{
					deviceCode: result.deviceCode,
					userCode: result.userCode,
					verificationUri,
					verificationUriComplete: `${verificationUri}?device=${encodeURIComponent(result.userCode)}`,
					expiresIn: result.expiresIn,
					interval: result.interval
				},
				{ status: 201 }
			);
		})
	);
