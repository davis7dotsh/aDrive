import type { RequestHandler } from './$types';
import { Effect } from 'effect';
import { runEdge } from '$lib/server/edge';
import { requireAdmin } from '$lib/server/request-auth';
import { Admin } from '$lib/server/services/admin';

export const GET: RequestHandler = (event) =>
	runEdge(
		Effect.gen(function* () {
			const admin = yield* Admin;
			yield* requireAdmin(event);
			return Response.json(yield* admin.overview);
		})
	);
