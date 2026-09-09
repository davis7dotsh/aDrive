import { JobSchema, type FailedJob } from '@adrive/shared';
import type { PgClient } from '@effect/sql-pg';
import { Effect, Schema } from 'effect';
import { StorageError } from './errors';

export interface DeadLetter {
	readonly id: string;
	readonly body: unknown;
	readonly attempts: number;
	readonly error: string;
}

const decodeJob = Schema.decodeUnknownOption(JobSchema);

const FailedJobRow = Schema.Struct({
	id: Schema.String,
	kind: Schema.String,
	payload: Schema.Unknown,
	error: Schema.String,
	attempts: Schema.Int,
	failed_at: Schema.String,
	resolved_at: Schema.NullOr(Schema.String)
});

const decodeRows = Schema.decodeUnknownOption(Schema.Array(FailedJobRow));

// One row per dead-lettered message, keyed by the message id so the
// at-least-once DLQ delivery cannot double-record. A body that no longer
// decodes as a job is kept too (kind 'invalid', no org) so nothing the
// queue rejected disappears.
export const recordFailedJob = (sql: PgClient.PgClient, letter: DeadLetter) =>
	Effect.gen(function* () {
		const job = decodeJob(letter.body);
		const orgId = job._tag === 'Some' ? job.value.orgId : null;
		const kind = job._tag === 'Some' ? job.value.kind : 'invalid';
		const rows = yield* sql<{ id: string }>`
			INSERT INTO failed_jobs (id, org_id, kind, payload, error, attempts)
			VALUES (
				${letter.id}, ${orgId}, ${kind}, ${JSON.stringify(letter.body ?? null)}::jsonb,
				${letter.error}, ${letter.attempts}
			)
			ON CONFLICT (id) DO NOTHING
			RETURNING id`;
		return { orgId, kind, recorded: rows.length === 1 };
	}).pipe(
		Effect.mapError(
			(cause) => new StorageError({ operation: 'record failed job', cause })
		)
	);

export const listFailedJobs = (
	sql: PgClient.PgClient,
	orgId: string,
	limit = 100
) =>
	sql`
		SELECT id, kind, payload, error, attempts, failed_at, resolved_at
		FROM failed_jobs
		WHERE org_id = ${orgId}
		ORDER BY failed_at DESC, id
		LIMIT ${Math.max(1, Math.min(limit, 500))}`.pipe(
		Effect.map((rows): ReadonlyArray<FailedJob> => {
			const decoded = decodeRows(rows);
			return decoded._tag === 'Some'
				? decoded.value.map((row) => ({
						id: row.id,
						kind: row.kind,
						payload: row.payload,
						error: row.error,
						attempts: row.attempts,
						failedAt: row.failed_at,
						resolvedAt: row.resolved_at
					}))
				: [];
		}),
		Effect.mapError(
			(cause) => new StorageError({ operation: 'list failed jobs', cause })
		)
	);

// Optional operator alert. The URL is a secret rather than a var so it
// stays out of wrangler.jsonc; absent means no alert. Delivery is best
// effort: the rows are already committed and the batch is acked either
// way, so a webhook outage cannot dead-letter the dead letters.
export const alertWebhookUrl = (env: Env) => {
	const value: unknown = Reflect.get(env, 'ALERT_WEBHOOK_URL');
	return typeof value === 'string' && value.length > 0 ? value : null;
};

export const postFailedJobAlert = (
	url: string,
	summary: {
		readonly queue: string;
		readonly recorded: number;
		readonly kinds: ReadonlyArray<string>;
		readonly orgIds: ReadonlyArray<string>;
	}
) =>
	Effect.tryPromise(() =>
		fetch(url, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({
				text: `adrive: ${summary.recorded} job(s) dead-lettered on ${summary.queue}`,
				...summary
			})
		})
	).pipe(
		Effect.asVoid,
		Effect.catchCause((cause) =>
			Effect.sync(() => {
				console.error(
					JSON.stringify({
						message: 'failed job alert could not be delivered',
						cause: String(cause)
					})
				);
			})
		)
	);
