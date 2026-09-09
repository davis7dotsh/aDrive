import type { RequestHandler } from './$types';
import { Effect } from 'effect';
import { authRateLimitResponse } from '$lib/server/auth-rate-limit-response';
import { runEdge } from '$lib/server/edge';
import { requireWrite } from '$lib/server/request-auth';
import { AuthGuard } from '$lib/server/services/auth-guard';
import { Files } from '$lib/server/services/files';

export const PUT: RequestHandler = (event) => {
	const { params, request } = event;
	return runEdge(
		Effect.gen(function* () {
			const authGuard = yield* AuthGuard;
			const files = yield* Files;
			const credential = yield* requireWrite(event);
			const rateLimit = yield* authGuard.consume(
				'upload',
				credential.credentialId
			);
			if (!rateLimit.allowed) {
				return authRateLimitResponse(
					rateLimit,
					'Too many uploads. Try again later.'
				);
			}
			const result = yield* files.uploadVersion({
				id: params.id,
				contentType:
					request.headers.get('content-type') ?? 'application/octet-stream',
				contentLength: request.headers.get('content-length'),
				body: request.body
			});
			return Response.json(result, { status: 201 });
		})
	);
};
