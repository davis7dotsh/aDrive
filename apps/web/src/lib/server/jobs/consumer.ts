import { JobSchema, type Job } from '@adrive/shared';
import { Effect, Schema } from 'effect';
import { runWorkerProgram, type AppServices } from '../edge';
import type { StorageError } from '../errors';

// The subset of a Cloudflare MessageBatch the consumer needs. A real
// MessageBatch satisfies it, and so does the JSON the Worker facade posts
// to /api/internal/jobs.
export interface JobMessage {
	readonly id: string;
	readonly body: unknown;
	readonly attempts: number;
}

export interface JobBatch {
	readonly queue: string;
	readonly messages: ReadonlyArray<JobMessage>;
}

export type JobAction = 'ack' | 'retry';

export interface JobDecision {
	readonly id: string;
	readonly action: JobAction;
}

const log = (entry: Record<string, unknown>) =>
	Effect.sync(() => {
		console.log(JSON.stringify(entry));
	});

// Dispatch by job kind. Every branch only logs for now; the queue is wired
// end to end before any behaviour moves onto it.
export const runJob = (
	job: Job
): Effect.Effect<void, StorageError, AppServices> => {
	switch (job.kind) {
		case 'index':
			// TODO(D2): indexing.runOne(job); ack when the version is stale.
			return log({
				message: 'job received',
				kind: job.kind,
				fileId: job.fileId,
				version: job.version
			});
		case 'scan':
			// TODO(D2): content scanning runs beside indexing.
			return log({
				message: 'job received',
				kind: job.kind,
				fileId: job.fileId,
				version: job.version
			});
		case 'purge':
			// TODO(D3): files.purgeOne(job.fileId) after the retention delay.
			return log({
				message: 'job received',
				kind: job.kind,
				fileId: job.fileId
			});
		case 'site-cleanup':
			// TODO(D3): sites.cleanupSession(job.sessionId).
			return log({
				message: 'job received',
				kind: job.kind,
				sessionId: job.sessionId
			});
	}
};

const decodeJob = Schema.decodeUnknownEffect(JobSchema);

// Invalid bodies are acked: retrying can never make them decode. Failed
// jobs are retried; the queue's max_retries and dead-letter queue bound it.
const consumeMessage = <R>(
	queue: string,
	message: JobMessage,
	run: (job: Job) => Effect.Effect<void, StorageError, R>
) =>
	Effect.gen(function* () {
		const decoded = yield* Effect.result(decodeJob(message.body));
		if (decoded._tag === 'Failure') {
			yield* log({
				message: 'job message is invalid',
				queue,
				id: message.id,
				cause: String(decoded.failure)
			});
			return 'ack' as const;
		}
		const outcome = yield* Effect.result(run(decoded.success));
		if (outcome._tag === 'Failure') {
			yield* log({
				message: 'job failed',
				queue,
				id: message.id,
				kind: decoded.success.kind,
				attempts: message.attempts,
				cause: String(outcome.failure.cause)
			});
			return 'retry' as const;
		}
		return 'ack' as const;
	});

export const consumeBatch = <R>(
	batch: JobBatch,
	run: (job: Job) => Effect.Effect<void, StorageError, R>
) =>
	Effect.forEach(batch.messages, (message) =>
		consumeMessage(batch.queue, message, run).pipe(
			Effect.map((action): JobDecision => ({ id: message.id, action }))
		)
	);

export const handleJobBatch = (env: Env, batch: JobBatch) =>
	runWorkerProgram(env, consumeBatch(batch, runJob));
