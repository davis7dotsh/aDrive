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
}

export class JobQueue extends Context.Service<JobQueue, JobQueueShape>()(
	'app/JobQueue'
) {}

const makeJobQueue = Effect.gen(function* () {
	const queue = yield* Jobs;

	return JobQueue.of({
		send: Effect.fn('JobQueue.send')(function* (job, options) {
			yield* Effect.tryPromise({
				try: () => queue.send(job, { contentType: 'json', ...options }),
				catch: (cause) =>
					new StorageError({ operation: `enqueue ${job.kind} job`, cause })
			});
		})
	});
});

export const JobQueueLive = Layer.effect(JobQueue, makeJobQueue);

// For tests and environments without the JOBS binding: sends succeed and
// go nowhere.
export const JobQueueNull = Layer.succeed(
	JobQueue,
	JobQueue.of({ send: () => Effect.void })
);
