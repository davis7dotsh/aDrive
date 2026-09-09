import { JobSchema, type Job } from '@adrive/shared';
import { Effect, Schema } from 'effect';
import type { AppServices } from '../edge';
import { StorageError } from '../errors';
import { retryDelaySeconds } from '../job-policy';
import { requestLayer } from '../layer';
import { Files } from '../services/files';
import { Indexing, type IndexOutcome } from '../services/indexing';
import { Scanner } from '../services/scanner';
import { Sites } from '../services/sites';

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

// What the facade does with one message. `retry` hands it back to the
// queue after `delaySeconds`; the queue's max_retries then bounds how
// often a job can come back before it dead-letters.
export type JobAction =
	| { readonly ack: true }
	| { readonly retry: true; readonly delaySeconds: number };

export type JobDecision = { readonly id: string } & JobAction;

export const ack: JobAction = { ack: true };
export const retryAfter = (delaySeconds: number): JobAction => ({
	retry: true,
	delaySeconds
});

// What a job handler reports back. Handlers own their persistence: a
// failure they recorded on the row is `done`; only a failure they could
// not record (the storage itself was unreachable) asks for a redelivery,
// and a job that must run again later (a purge whose time is not yet
// up) re-sends itself and reports `done`.
export type JobOutcome = 'done' | 'retry';

export type JobOf<K extends Job['kind']> = Extract<Job, { kind: K }>;

// One handler per job kind. To add a kind: extend JobSchema in
// packages/shared, add its handler here and in liveJobHandlers, and
// cover the dispatch in consumer.test.ts.
export interface JobHandlers {
	readonly index: (
		job: JobOf<'index'>
	) => Effect.Effect<JobOutcome, StorageError>;
	readonly scan: (
		job: JobOf<'scan'>
	) => Effect.Effect<JobOutcome, StorageError>;
	readonly purge: (
		job: JobOf<'purge'>
	) => Effect.Effect<JobOutcome, StorageError>;
	readonly siteCleanup: (
		job: JobOf<'site-cleanup'>
	) => Effect.Effect<JobOutcome, StorageError>;
}

const log = (entry: Record<string, unknown>) =>
	Effect.sync(() => {
		console.log(JSON.stringify(entry));
	});

export const dispatchJob = (handlers: JobHandlers) => (job: Job) => {
	switch (job.kind) {
		case 'index':
			return handlers.index(job);
		case 'scan':
			return handlers.scan(job);
		case 'purge':
			return handlers.purge(job);
		case 'site-cleanup':
			return handlers.siteCleanup(job);
	}
};

// Only an attempt that could not run asks for a redelivery; a permanent
// failure is already on the row and a stale version has nothing to do.
export const indexOutcome = (outcome: IndexOutcome): JobOutcome =>
	outcome === 'retry' ? 'retry' : 'done';

export const liveJobHandlers = Effect.gen(function* () {
	const indexing = yield* Indexing;
	const files = yield* Files;
	const sites = yield* Sites;
	const scanner = yield* Scanner;
	return {
		index: (job) => indexing.runOne(job).pipe(Effect.map(indexOutcome)),
		// The scanner records its own outcome (a verdict row, a re-sent
		// poll); only storage trouble asks for a redelivery.
		scan: (job) => scanner.runOne(job).pipe(Effect.as('done')),
		purge: (job) => files.purgeOne(job.fileId).pipe(Effect.as('done')),
		siteCleanup: (job) =>
			sites.cleanupSession(job.sessionId).pipe(Effect.as('done'))
	} satisfies JobHandlers;
});

export const runJob = (
	job: Job
): Effect.Effect<JobOutcome, StorageError, AppServices> =>
	Effect.flatMap(liveJobHandlers, (handlers) => dispatchJob(handlers)(job));

const decodeJob = Schema.decodeUnknownEffect(JobSchema);

// Invalid bodies are acked: retrying can never make them decode. A
// StorageError (Postgres, R2, or Workers AI unreachable) is transient and
// retried with backoff; the queue's max_retries and dead-letter queue
// bound it.
const consumeMessage = <R>(
	queue: string,
	message: JobMessage,
	run: (
		job: Job,
		attempts: number
	) => Effect.Effect<JobOutcome, StorageError, R>
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
			return ack;
		}
		const job = decoded.success;
		const outcome = yield* Effect.result(run(job, message.attempts));
		if (outcome._tag === 'Failure') {
			yield* log({
				message: 'job failed',
				queue,
				id: message.id,
				kind: job.kind,
				orgId: job.orgId,
				attempts: message.attempts,
				cause: String(outcome.failure.cause)
			});
			return retryAfter(retryDelaySeconds(message.attempts));
		}
		if (outcome.success === 'retry') {
			yield* log({
				message: 'job asked to run again',
				queue,
				id: message.id,
				kind: job.kind,
				orgId: job.orgId,
				attempts: message.attempts
			});
			return retryAfter(retryDelaySeconds(message.attempts));
		}
		return ack;
	});

export const consumeBatch = <R>(
	batch: JobBatch,
	run: (
		job: Job,
		attempts: number
	) => Effect.Effect<JobOutcome, StorageError, R>
) =>
	Effect.forEach(batch.messages, (message) =>
		consumeMessage(batch.queue, message, run).pipe(
			Effect.map((action): JobDecision => ({ id: message.id, ...action }))
		)
	);

// Each job runs in its own layer bound to the job's org (the same layer
// runWorkerProgram builds), so the services only ever see that tenant's
// rows. `local` matters: the jobs route already runs under a tenant-less
// layer, and nested provides otherwise share memoized services, which
// would hand the job the anonymous org. A defect (a bug, not a
// StorageError) escapes the batch as a rejection; the facade then
// retries every message, which is the safe default for an unknown
// failure.
export const runJobForOrg = (env: Env) => (job: Job) =>
	runJob(job).pipe(
		Effect.provide(requestLayer(env, { orgId: job.orgId, userId: 'system' }), {
			local: true
		}),
		Effect.catchTag('SqlError', (cause) =>
			Effect.fail(new StorageError({ operation: 'connect for job', cause }))
		),
		// The org was deleted after the job was sent. Nothing to do, and
		// retrying would only dead-letter it.
		Effect.catchTag('OrgMissing', (missing) =>
			log({
				message: 'job skipped for a missing org',
				kind: job.kind,
				orgId: missing.orgId
			}).pipe(Effect.as('done' as const))
		)
	);

export const handleJobBatch = (env: Env, batch: JobBatch) =>
	Effect.runPromise(consumeBatch(batch, runJobForOrg(env)));
