import type { RequestHandler } from './$types';
import { Effect } from 'effect';
import { runEdge } from '$lib/server/edge';
import { Auth } from '$lib/server/services/auth';

export const GET: RequestHandler = ({ request, url }) =>
	runEdge(
		Effect.gen(function* () {
			const auth = yield* Auth;
			yield* auth.authorize({
				authorization: request.headers.get('authorization'),
				requestOrigin: url.origin
			});
			return Response.json({ ok: true as const });
		})
	);
