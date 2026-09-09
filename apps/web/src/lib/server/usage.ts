import type { PgClient } from '@effect/sql-pg';
import { Effect } from 'effect';
import { StorageError } from './errors';

// The org_usage row as billing reads it. stored_bytes is moved by the
// storage quota; the AI counters are moved here.
export interface OrgUsage {
	readonly storedBytes: number;
	readonly fileCount: number;
	// Chunks embedded this calendar month, already zero once the month
	// the row counted has passed.
	readonly aiOpsMonth: number;
	readonly aiOpsPending: number;
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
		ai_ops_pending: number;
	}>`
		SELECT stored_bytes, file_count,
			CASE
				WHEN ai_ops_month_reset_at IS NULL OR ai_ops_month_reset_at <= now()
				THEN 0
				ELSE ai_ops_month
			END AS ai_ops_month,
			ai_ops_pending
		FROM org_usage
		WHERE org_id = ${orgId}`.pipe(Effect.mapError(storage('read org usage')));
	const row = rows[0];
	if (!row) return null;
	return {
		storedBytes: row.stored_bytes,
		fileCount: row.file_count,
		aiOpsMonth: row.ai_ops_month,
		aiOpsPending: row.ai_ops_pending
	} satisfies OrgUsage;
});

// Counts embedded chunks: this month's total (restarted when the month
// the row counted is over) and the amount still owed to Autumn.
export const recordAiOps = Effect.fn('Usage.recordAiOps')(function* (
	sql: PgClient.PgClient,
	orgId: string,
	value: number
) {
	if (value <= 0) return;
	yield* sql`
		UPDATE org_usage
		SET ai_ops_month = CASE
				WHEN ai_ops_month_reset_at IS NULL OR ai_ops_month_reset_at <= now()
				THEN ${value}::integer
				ELSE ai_ops_month + ${value}::integer
			END,
			ai_ops_month_reset_at = CASE
				WHEN ai_ops_month_reset_at IS NULL OR ai_ops_month_reset_at <= now()
				THEN date_trunc('month', now()) + interval '1 month'
				ELSE ai_ops_month_reset_at
			END,
			ai_ops_pending = ai_ops_pending + ${value}::integer
		WHERE org_id = ${orgId}`.pipe(Effect.mapError(storage('record AI usage')));
});

// After Autumn accepted `value`, take it off the pending count. Anything
// recorded meanwhile stays owed for the next sync.
export const settleAiOps = Effect.fn('Usage.settleAiOps')(function* (
	sql: PgClient.PgClient,
	orgId: string,
	value: number
) {
	if (value <= 0) return;
	yield* sql`
		UPDATE org_usage
		SET ai_ops_pending = GREATEST(0, ai_ops_pending - ${value}::integer)
		WHERE org_id = ${orgId}`.pipe(Effect.mapError(storage('settle AI usage')));
});
