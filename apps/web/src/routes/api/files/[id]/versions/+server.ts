import type { RequestHandler } from './$types';
import { Effect } from 'effect';
import { rateLimitResponse } from '$lib/server/auth-rate-limit-response';
import { runEdge } from '$lib/server/edge';
import { requireWrite } from '$lib/server/request-auth';
import { RateLimits } from '$lib/server/services/rate-limits';
import { Files } from '$lib/server/services/files';

export const PUT: RequestHandler = (event) => {
	const { params, request } = event;
	return runEdge(
		Effect.gen(function* () {
			const rateLimits = yield* RateLimits;
			const files = yield* Files;
			const credential = yield* requireWrite(event);
			const rateLimit = yield* rateLimits.upload(credential.orgId);
			if (!rateLimit.allowed) {
				return rateLimitResponse('Too many uploads. Try again later.');
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
