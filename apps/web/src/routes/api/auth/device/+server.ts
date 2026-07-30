import { DeviceAuthorizationCreateSchema } from '@adrive/shared';
import type { RequestHandler } from './$types';
import { Effect } from 'effect';
import { authRateLimitResponse } from '$lib/server/auth-rate-limit-response';
import { AppConfig } from '$lib/server/config';
import { runEdge } from '$lib/server/edge';
import { decodeJson } from '$lib/server/request-json';
import { Auth } from '$lib/server/services/auth';
import { AuthGuard } from '$lib/server/services/auth-guard';

export const POST: RequestHandler = ({ request, getClientAddress }) =>
	runEdge(
		Effect.gen(function* () {
			const auth = yield* Auth;
			const authGuard = yield* AuthGuard;
			const config = yield* AppConfig;
			const rateLimit = yield* authGuard.consume(
				'deviceCreate',
				getClientAddress()
			);
			if (!rateLimit.allowed) return authRateLimitResponse(rateLimit);
			const input = yield* decodeJson(
				request,
				DeviceAuthorizationCreateSchema,
				'A device name is required'
			);
			const result = yield* auth.createDeviceAuthorization(input.name);
			const verificationUri = `${config.dashboardOrigin}/`;
			const expiresAt = Math.floor(Date.now() / 1_000) + result.expiresIn;
			const verificationUriComplete = new URL(verificationUri);
			verificationUriComplete.searchParams.set('device', result.userCode);
			verificationUriComplete.searchParams.set('expires', String(expiresAt));
			return Response.json(
				{
					deviceCode: result.deviceCode,
					userCode: result.userCode,
					verificationUri,
					verificationUriComplete: verificationUriComplete.href,
					expiresIn: result.expiresIn,
					interval: result.interval
				},
				{ status: 201 }
			);
		})
	);
