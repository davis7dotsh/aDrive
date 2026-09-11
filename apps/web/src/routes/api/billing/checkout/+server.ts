import type { RequestHandler } from './$types';
import { Effect } from 'effect';
import { runEdge } from '$lib/server/edge';
import { requireOwner } from '$lib/server/request-auth';
import { Billing } from '$lib/server/services/billing';

// Starts the pro upgrade. The browser follows the URL to the hosted
// checkout; a null URL means the plan attached without a payment step.
export const POST: RequestHandler = (event) =>
	runEdge(
		Effect.gen(function* () {
			const billing = yield* Billing;
			yield* requireOwner(event, 'change the plan');
			return Response.json(
				{ url: yield* billing.checkoutUrl },
				{ headers: { 'Cache-Control': 'private, no-store' } }
			);
		})
	);
