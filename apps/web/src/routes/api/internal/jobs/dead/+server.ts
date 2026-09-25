import type { RequestHandler } from './$types';
import { Effect } from 'effect';
import { runEdge } from '$lib/server/edge';
import { InvalidRequest } from '$lib/server/errors';
import { readSignedBatch } from '$lib/server/jobs/batch-request';
import { consumeDeadLetters } from '$lib/server/jobs/dead-letters';

// Dead-letter queue deliveries from the Worker facade: each message is
// written to failed_jobs and acked.
export const POST: RequestHandler = ({ request, platform }) =>
	runEdge(
		Effect.gen(function* () {
			const env = platform?.env;
			if (!env) {
				return yield* new InvalidRequest({
					status: 400,
					message: 'Cloudflare bindings unavailable'
				});
			}
			const batch = yield* readSignedBatch(request);
			const decisions = yield* consumeDeadLetters(env, batch);
			return Response.json({ decisions });
		})
	);
