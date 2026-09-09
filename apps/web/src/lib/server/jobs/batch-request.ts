import { Effect, Schema } from 'effect';
import { AppConfig } from '../config';
import { verifyJobsRequest } from '../cron-auth';
import { InvalidRequest, Unauthorized } from '../errors';
import { readBoundedText } from '../request-json';

// The batch JSON the Worker facade posts for either queue: verified
// against the HMAC over the exact body, then decoded.
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

const invalid = (status: 400 | 413, message: string) =>
	new InvalidRequest({ status, message });

const unauthorized = () =>
	new Unauthorized({ message: 'Queue request is unauthorized' });

export const readSignedBatch = (request: Request) =>
	Effect.gen(function* () {
		const config = yield* AppConfig;
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

		return yield* Effect.try({
			try: (): unknown => JSON.parse(text),
			catch: () => invalid(400, 'Queue batch is invalid')
		}).pipe(
			Effect.flatMap(Schema.decodeUnknownEffect(JobBatchBody)),
			Effect.mapError((cause) =>
				cause instanceof InvalidRequest
					? cause
					: invalid(400, 'Queue batch is invalid')
			)
		);
	});
