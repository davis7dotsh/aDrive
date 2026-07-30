import type { RequestHandler } from './$types';
import { Effect } from 'effect';
import { AppConfig } from '$lib/server/config';
import { runEdgeWithEvent, runWorkerProgram } from '$lib/server/edge';
import { Auth, authorizeRequest } from '$lib/server/services/auth';
import { Indexing } from '$lib/server/services/indexing';
import { Sites } from '$lib/server/services/sites';

export const POST: RequestHandler = async (event) => {
	const { cookies, params, request, url } = event;
	const output = await runEdgeWithEvent(
		event,
		Effect.gen(function* () {
			const auth = yield* Auth;
			const config = yield* AppConfig;
			const sites = yield* Sites;
			yield* authorizeRequest(auth, request, url, cookies);
			const result = yield* sites.commit(params.id);
			return {
				fileId: result.file.id,
				response: Response.json(
					{
						...result,
						url: `${config.contentOrigin}/s/${result.file.id}/`
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
