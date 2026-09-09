import type { RequestHandler } from './$types';
import { Effect } from 'effect';
import { runEdge } from '$lib/server/edge';
import { requireAuth } from '$lib/server/request-auth';

export const GET: RequestHandler = (event) => {
	const { request } = event;
	return runEdge(
		Effect.gen(function* () {
			yield* requireAuth(event);
			return Response.json({ ok: true as const });
		})
	);
};
