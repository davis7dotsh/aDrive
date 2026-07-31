import type { RequestHandler } from './$types';
import { Effect } from 'effect';
import { authRateLimitResponse } from '$lib/server/auth-rate-limit-response';
import { runEdgeWithEvent, runWorkerProgram } from '$lib/server/edge';
import { Auth, authorizeWriteRequest } from '$lib/server/services/auth';
import { AuthGuard } from '$lib/server/services/auth-guard';
import { Files } from '$lib/server/services/files';
import { Indexing } from '$lib/server/services/indexing';

export const PUT: RequestHandler = async (event) => {
	const { cookies, params, request, url } = event;
	const output = await runEdgeWithEvent(
		event,
		Effect.gen(function* () {
			const auth = yield* Auth;
			const authGuard = yield* AuthGuard;
			const files = yield* Files;
			const credential = yield* authorizeWriteRequest(
				auth,
				request,
				url,
				cookies
			);
			const rateLimit = yield* authGuard.consume(
				'upload',
				credential.credentialId
			);
			if (!rateLimit.allowed) {
				return {
					fileId: null,
					response: authRateLimitResponse(rateLimit)
				};
			}
			const result = yield* files.uploadVersion({
				id: params.id,
				contentType:
					request.headers.get('content-type') ?? 'application/octet-stream',
				contentLength: request.headers.get('content-length'),
				body: request.body
			});
			return {
				fileId: params.id,
				response: Response.json(result, { status: 201 })
			};
		})
	);
	const uploadedFileId = output.fileId;
	if (uploadedFileId !== null && event.platform) {
		event.platform.ctx.waitUntil(
			runWorkerProgram(
				event.platform.env,
				Effect.gen(function* () {
					const indexing = yield* Indexing;
					yield* indexing.process(uploadedFileId);
				})
			)
		);
	}
	return output.response;
};
