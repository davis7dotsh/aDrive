import type { Job } from '@adrive/shared';
import { Context, Effect, Layer } from 'effect';
import { StorageError } from '../errors';
import { Jobs } from './bindings';

export interface JobSendOptions {
	readonly delaySeconds?: number;
}

export interface JobQueueShape {
	readonly send: (
		job: Job,
		options?: JobSendOptions
	) => Effect.Effect<void, StorageError>;
	// For sends that follow a committed write: the row already says the
	// work is owed, so a queue outage is logged and left to the cron
	// reconciliation rather than failing the request.
	readonly trySend: (job: Job, options?: JobSendOptions) => Effect.Effect<void>;
}

export class JobQueue extends Context.Service<JobQueue, JobQueueShape>()(
	'app/JobQueue'
) {}

const withTrySend = (send: JobQueueShape['send']): JobQueueShape => ({
	send,
	trySend: (job, options) =>
		send(job, options).pipe(
			Effect.catchCause((cause) =>
				Effect.sync(() => {
					console.error(
						JSON.stringify({
							message: 'job could not be sent',
							kind: job.kind,
							orgId: job.orgId,
							cause: String(cause)
						})
					);
				})
			)
		)
});

const makeJobQueue = Effect.gen(function* () {
	const queue = yield* Jobs;

	return JobQueue.of(
		withTrySend(
			Effect.fn('JobQueue.send')(function* (job, options) {
				yield* Effect.tryPromise({
					try: () => queue.send(job, { contentType: 'json', ...options }),
					catch: (cause) =>
						new StorageError({ operation: `enqueue ${job.kind} job`, cause })
				});
			})
		)
	);
});

export const JobQueueLive = Layer.effect(JobQueue, makeJobQueue);

// For tests and environments without the JOBS binding: sends succeed and
// go nowhere.
export const JobQueueNull = Layer.succeed(
	JobQueue,
	JobQueue.of(withTrySend(() => Effect.void))
);
