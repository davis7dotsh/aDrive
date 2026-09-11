import type { PgClient } from '@effect/sql-pg';
import { Effect } from 'effect';
import { StorageError } from './errors';
import { STUCK_JOB_MS } from './job-policy';
import { planLimits } from './plans';
import type { JobQueue } from './services/jobs';

// The org_usage row as billing reads it. stored_bytes is moved by the
// storage quota; the AI counters are moved here.
export interface OrgUsage {
	readonly storedBytes: number;
	readonly fileCount: number;
	// Chunks embedded this calendar month, already zero once the month
	// the row counted has passed.
	readonly aiOpsMonth: number;
}

const storage = (operation: string) => (cause: unknown) =>
	new StorageError({ operation, cause });

export const readOrgUsage = Effect.fn('Usage.read')(function* (
	sql: PgClient.PgClient,
	orgId: string
) {
	const rows = yield* sql<{
		stored_bytes: number;
		file_count: number;
		ai_ops_month: number;
	}>`
		SELECT stored_bytes, file_count,
			CASE
				WHEN ai_ops_month_reset_at IS NULL OR ai_ops_month_reset_at <= now()
				THEN 0
				ELSE ai_ops_month
			END AS ai_ops_month
		FROM org_usage
		WHERE org_id = ${orgId}`.pipe(Effect.mapError(storage('read org usage')));
	const row = rows[0];
	if (!row) return null;
	return {
		storedBytes: row.stored_bytes,
		fileCount: row.file_count,
		aiOpsMonth: row.ai_ops_month
	} satisfies OrgUsage;
});

// Counts successfully indexed chunks in the current UTC calendar month.
export const recordAiOps = Effect.fn('Usage.recordAiOps')(function* (
	sql: PgClient.PgClient,
	orgId: string,
	value: number
) {
	if (value <= 0) return;
	const rows = yield* sql<{ org_id: string }>`
		UPDATE org_usage
		SET ai_ops_month = CASE
				WHEN ai_ops_month_reset_at IS NULL OR ai_ops_month_reset_at <= now()
				THEN ${value}::integer
				ELSE ai_ops_month + ${value}::integer
			END,
			ai_ops_month_reset_at = CASE
				WHEN ai_ops_month_reset_at IS NULL OR ai_ops_month_reset_at <= now()
				THEN (date_trunc('month', now() AT TIME ZONE 'UTC') + interval '1 month') AT TIME ZONE 'UTC'
				ELSE ai_ops_month_reset_at
			END
		WHERE org_id = ${orgId}
		RETURNING org_id`.pipe(Effect.mapError(storage('record AI usage')));
	if (rows.length !== 1) {
		return yield* new StorageError({
			operation: 'record AI usage',
			cause: 'The organization has no usage row'
		});
	}
});

// Pin the plan, then the usage row, before taking a fresh snapshot. The
// separate read sees counters committed while either lock was waiting.
const holdUsage = (sql: PgClient.PgClient, orgId: string) =>
	Effect.gen(function* () {
		yield* sql`SELECT id FROM orgs WHERE id = ${orgId} FOR SHARE`;
		yield* sql`SELECT org_id FROM org_usage WHERE org_id = ${orgId} FOR UPDATE`;
		const rows = yield* sql<{ plan: string; used: number }>`
		SELECT o.plan,
			CASE WHEN u.ai_ops_month_reset_at IS NULL OR u.ai_ops_month_reset_at <= now()
				THEN 0 ELSE u.ai_ops_month END AS used
		FROM org_usage u JOIN orgs o ON o.id = u.org_id
		WHERE u.org_id = ${orgId}`;
		const row = rows.at(0);
		if (!row)
			return yield* new StorageError({
				operation: 'lock AI quota',
				cause: 'The organization has no usage row'
			});
		return row;
	}).pipe(Effect.mapError(storage('lock AI quota')));

export const reserveAiOps = Effect.fn('Usage.reserveAiOps')(function* (
	sql: PgClient.PgClient,
	orgId: string,
	token: string,
	value: number,
	expiresAt: string
) {
	if (value <= 0) return true;
	return yield* sql
		.withTransaction(
			Effect.gen(function* () {
				const usage = yield* holdUsage(sql, orgId);
				yield* sql`DELETE FROM ai_usage_reservations
			WHERE org_id = ${orgId} AND expires_at <= clock_timestamp()`;
				const existing = yield* sql<{ value: number }>`
			SELECT value FROM ai_usage_reservations
			WHERE org_id = ${orgId} AND token = ${token}`;
				if (existing.length > 0) return existing[0]?.value === value;
				const reserved = yield* sql<{ value: number }>`
			SELECT COALESCE(sum(value), 0)::integer AS value
			FROM ai_usage_reservations WHERE org_id = ${orgId}`;
				if (
					usage.used + (reserved[0]?.value ?? 0) + value >
					planLimits(usage.plan).aiOpsPerMonth
				) {
					return false;
				}
				const inserted = yield* sql<{ token: string }>`
			INSERT INTO ai_usage_reservations (token, org_id, value, expires_at)
			SELECT ${token}, ${orgId}, ${value}, ${expiresAt}::timestamptz
			WHERE ${expiresAt}::timestamptz > clock_timestamp()
			RETURNING token`;
				if (inserted.length !== 1)
					return yield* new StorageError({
						operation: 'reserve AI quota',
						cause: 'The indexing lease expired before embeddings could start'
					});
				return true;
			})
		)
		.pipe(Effect.mapError(storage('reserve AI quota')));
});

// Called in the same transaction as semanticCommit. Losing or expiring
// the reservation rolls back both the ready state and its metering.
export const commitAiOps = Effect.fn('Usage.commitAiOps')(function* (
	sql: PgClient.PgClient,
	orgId: string,
	token: string
) {
	yield* holdUsage(sql, orgId);
	const rows = yield* sql<{ value: number }>`
		DELETE FROM ai_usage_reservations
		WHERE org_id = ${orgId} AND token = ${token} AND expires_at > clock_timestamp()
		RETURNING value`.pipe(Effect.mapError(storage('commit AI reservation')));
	const row = rows.at(0);
	if (!row)
		return yield* new StorageError({
			operation: 'commit AI reservation',
			cause: 'The AI reservation expired before indexing completed'
		});
	yield* recordAiOps(sql, orgId, row.value);
});

export const releaseAiOps = (
	sql: PgClient.PgClient,
	orgId: string,
	token: string
) =>
	sql`DELETE FROM ai_usage_reservations WHERE org_id = ${orgId} AND token = ${token}`.pipe(
		Effect.asVoid,
		Effect.mapError(storage('release AI reservation'))
	);

// Periodic absolute storage snapshots also repair a lost upload/purge
// enqueue. The durable due time retries a lost recovery send next sweep.
export const recoverUsageSync = (
	sql: PgClient.PgClient,
	jobs: JobQueue['Service'],
	orgId: string
) =>
	Effect.gen(function* () {
		const rows = yield* sql<{ org_id: string }>`
			UPDATE org_usage u
			SET usage_sync_next_run_at = clock_timestamp() + ${STUCK_JOB_MS} * interval '1 millisecond'
			WHERE u.org_id IN (
				SELECT due.org_id FROM org_usage due
				WHERE due.org_id = ${orgId} AND due.usage_sync_next_run_at <= now()
				FOR UPDATE SKIP LOCKED
			)
			RETURNING org_id`.pipe(Effect.mapError(storage('recover usage sync')));
		if (rows.length > 0) yield* jobs.trySend({ kind: 'usage-sync', orgId });
		return rows.length;
	});
