import type { RequestHandler } from './$types';
import { Effect } from 'effect';
import { runEdge } from '$lib/server/edge';
import { requireWrite } from '$lib/server/request-auth';
import { Auth } from '$lib/server/services/auth';

export const DELETE: RequestHandler = (event) => {
	const { params, request } = event;
	return runEdge(
		Effect.gen(function* () {
			const auth = yield* Auth;
			yield* requireWrite(event);
			yield* auth.revokeApiKey(params.id);
			return new Response(null, { status: 204 });
		})
	);
};
