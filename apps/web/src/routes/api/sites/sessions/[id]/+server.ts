import type { RequestHandler } from './$types';
import { Effect } from 'effect';
import { runEdge } from '$lib/server/edge';
import { Auth, authorizeWriteRequest } from '$lib/server/services/auth';
import { Sites } from '$lib/server/services/sites';

export const DELETE: RequestHandler = ({ cookies, params, request, url }) =>
	runEdge(
		Effect.gen(function* () {
			const auth = yield* Auth;
			const sites = yield* Sites;
			yield* authorizeWriteRequest(auth, request, url, cookies);
			yield* sites.abort(params.id);
			return new Response(null, { status: 204 });
		})
	);
