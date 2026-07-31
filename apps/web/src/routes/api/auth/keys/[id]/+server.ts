import type { RequestHandler } from './$types';
import { Effect } from 'effect';
import { runEdge } from '$lib/server/edge';
import { Auth, authorizeWriteRequest } from '$lib/server/services/auth';

export const DELETE: RequestHandler = ({ cookies, params, request, url }) =>
	runEdge(
		Effect.gen(function* () {
			const auth = yield* Auth;
			yield* authorizeWriteRequest(auth, request, url, cookies);
			yield* auth.revokeApiKey(params.id);
			return new Response(null, { status: 204 });
		})
	);
