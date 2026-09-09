import type { RequestHandler } from './$types';
import { Effect, Schema } from 'effect';
import { AppConfig } from '$lib/server/config';
import { verifyJobsRequest } from '$lib/server/cron-auth';
import { runEdge } from '$lib/server/edge';
import { InvalidRequest, Unauthorized } from '$lib/server/errors';
import { consumeBatch, runJobForOrg } from '$lib/server/jobs/consumer';
import { readBoundedText } from '$lib/server/request-json';

// The Worker facade (scripts/cloudflare-adapter.mjs) receives queue
// batches and forwards them here in-process, because the consumer has to
// run inside the SvelteKit bundle to reach $lib. The response tells the
// facade which messages to ack and which to retry (and after how long).
// The request itself carries no tenant; every job builds its own layer
// for the org named in its body.
const JobBatchBody = Schema.Struct({
	queue: Schema.String,
	messages: Schema.Array(
		Schema.Struct({
			id: Schema.String,
			attempts: Schema.Int,
			body: Schema.Unknown
		})
	)
});

const MAX_BATCH_BYTES = 1024 * 1024;

const unauthorized = () =>
	new Unauthorized({ message: 'Queue request is unauthorized' });

export const POST: RequestHandler = ({ request, platform }) =>
	runEdge(
		Effect.gen(function* () {
			const config = yield* AppConfig;
			const env = platform?.env;
			if (!env) {
				return yield* new InvalidRequest({
					status: 400,
					message: 'Cloudflare bindings unavailable'
				});
			}
			const text = yield* readBoundedText(request, {
				maxBytes: MAX_BATCH_BYTES,
				invalidLengthMessage: 'Queue batch is too large',
				invalidTextMessage: 'Queue batch is invalid'
			});
			const authorized = yield* Effect.tryPromise({
				try: () =>
					verifyJobsRequest(
						config.maintenanceSecret,
						request.headers.get('x-adrive-jobs-time'),
						text,
						request.headers.get('x-adrive-jobs-signature')
					),
				catch: unauthorized
			});
			if (!authorized) return yield* unauthorized();

			const batch = yield* Effect.try({
				try: (): unknown => JSON.parse(text),
				catch: () =>
					new InvalidRequest({ status: 400, message: 'Queue batch is invalid' })
			}).pipe(
				Effect.flatMap(Schema.decodeUnknownEffect(JobBatchBody)),
				Effect.mapError((cause) =>
					cause instanceof InvalidRequest
						? cause
						: new InvalidRequest({
								status: 400,
								message: 'Queue batch is invalid'
							})
				)
			);
			const decisions = yield* consumeBatch(batch, runJobForOrg(env));
			return Response.json({ decisions });
		})
	);
