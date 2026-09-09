import type { RequestHandler } from './$types';
import { Effect } from 'effect';
import { runEdge } from '$lib/server/edge';
import { requireWrite } from '$lib/server/request-auth';
import { currentContentOrigin } from '$lib/server/services/current-org';
import { Sites } from '$lib/server/services/sites';

export const POST: RequestHandler = (event) => {
	const { params } = event;
	return runEdge(
		Effect.gen(function* () {
			const sites = yield* Sites;
			yield* requireWrite(event);
			const result = yield* sites.commit(params.id);
			return Response.json(
				{
					...result,
					url: `${yield* currentContentOrigin}/s/${result.file.id}/`
				},
				{ status: 201 }
			);
		})
	);
};
