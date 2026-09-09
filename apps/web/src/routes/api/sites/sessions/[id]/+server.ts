import type { RequestHandler } from './$types';
import { Effect } from 'effect';
import { runEdge } from '$lib/server/edge';
import { requireWrite } from '$lib/server/request-auth';
import { Sites } from '$lib/server/services/sites';

export const DELETE: RequestHandler = (event) => {
	const { params, request } = event;
	return runEdge(
		Effect.gen(function* () {
			const sites = yield* Sites;
			yield* requireWrite(event);
			yield* sites.abort(params.id);
			return new Response(null, { status: 204 });
		})
	);
};
