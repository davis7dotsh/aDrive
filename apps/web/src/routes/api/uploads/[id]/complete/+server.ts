import type { RequestHandler } from './$types';
import { Effect } from 'effect';
import { AppConfig } from '$lib/server/config';
import { runEdgeWithEvent, runWorkerProgram } from '$lib/server/edge';
import { Auth, authorizeWriteRequest } from '$lib/server/services/auth';
import { assertUnrestricted } from '$lib/server/token-scope';
import { Indexing } from '$lib/server/services/indexing';
import { Uploads } from '$lib/server/services/uploads';

export const POST: RequestHandler = async (event) => {
	const { cookies, params, request, url } = event;
	const output = await runEdgeWithEvent(
		event,
		Effect.gen(function* () {
			const auth = yield* Auth;
			const config = yield* AppConfig;
			const uploads = yield* Uploads;
			const credential = yield* authorizeWriteRequest(
				auth,
				request,
				url,
				cookies
			);
			yield* assertUnrestricted(credential);
			const result = yield* uploads.complete(params.id);
			return {
				fileId: result.file.id,
				response: Response.json(
					{
						file: result.file,
						url: `${config.contentOrigin}/f/${result.file.id}`,
						forcedPublic: result.forcedPublic
					},
					{ status: 201 }
				)
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
