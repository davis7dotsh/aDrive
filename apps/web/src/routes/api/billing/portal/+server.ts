import type { RequestHandler } from './$types';
import { Effect } from 'effect';
import { runEdge } from '$lib/server/edge';
import { requireOwner } from '$lib/server/request-auth';
import { Billing } from '$lib/server/services/billing';

export const POST: RequestHandler = (event) =>
	runEdge(
		Effect.gen(function* () {
			const billing = yield* Billing;
			yield* requireOwner(event, 'manage billing');
			return Response.json(
				{ url: yield* billing.portalUrl },
				{ headers: { 'Cache-Control': 'private, no-store' } }
			);
		})
	);
