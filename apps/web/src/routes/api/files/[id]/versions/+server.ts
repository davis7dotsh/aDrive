import type { RequestHandler } from './$types';
import { Effect } from 'effect';
import { runEdgeWithEvent, runWorkerProgram } from '$lib/server/edge';
import { Auth, authorizeRequest } from '$lib/server/services/auth';
import { Files } from '$lib/server/services/files';
import { Indexing } from '$lib/server/services/indexing';

export const PUT: RequestHandler = async (event) => {
	const { cookies, params, request, url } = event;
	const output = await runEdgeWithEvent(
		event,
		Effect.gen(function* () {
			const auth = yield* Auth;
			const files = yield* Files;
			yield* authorizeRequest(auth, request, url, cookies);
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
	if (event.platform) {
		event.platform.ctx.waitUntil(
			runWorkerProgram(
				event.platform.env,
				Effect.gen(function* () {
					const indexing = yield* Indexing;
					yield* indexing.process(output.fileId);
				})
			)
		);
	}
	return output.response;
};
