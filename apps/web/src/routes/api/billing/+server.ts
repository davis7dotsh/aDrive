import type { RequestHandler } from './$types';
import { Effect } from 'effect';
import { runEdge } from '$lib/server/edge';
import { requireAuth } from '$lib/server/request-auth';
import { Billing } from '$lib/server/services/billing';

export const GET: RequestHandler = (event) =>
	runEdge(
		Effect.gen(function* () {
			const billing = yield* Billing;
			const auth = yield* requireAuth(event);
			return Response.json(
				{
					...(yield* billing.summary),
					canManageBilling: auth.role === 'owner' && auth.scope === 'read-write'
				},
				{
					headers: { 'Cache-Control': 'private, no-store' }
				}
			);
		})
	);
