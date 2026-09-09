import { dashboardThumbnailPrefix } from '../../../file-thumbnail';
import { StorageError } from '../../errors';
import { stuckBefore } from '../../job-policy';
import { completePurge } from '../../purge-sql';
import { retryAt, safeIndexError } from '../../semantic-policy';
import { Effect, Schema } from 'effect';
import { forgetTagListCache } from '../tags';
import type { FileInternals } from './internals';
import type { FilesShape } from './types';

const PURGE_LEASE_MS = 5 * 60 * 1_000;

const PurgeRow = Schema.Struct({
	deleted_at: Schema.NullOr(Schema.String),
	purge_at: Schema.NullOr(Schema.String),
	expires_at: Schema.NullOr(Schema.String),
	purge_state: Schema.String,
	purge_next_run_at: Schema.NullOr(Schema.String)
});

const decodePurgeRows = Schema.decodeUnknownOption(Schema.Array(PurgeRow));

// When the file is owed a purge: the trash deadline once it is in the
// trash, or its expiry, whichever comes first. Null means it is neither
// trashed nor expiring (restored, or the expiry was cleared).
export const purgeDueAt = (row: {
	readonly deleted_at: string | null;
	readonly purge_at: string | null;
	readonly expires_at: string | null;
}) => {
	const candidates = [
		row.deleted_at !== null ? row.purge_at : null,
		row.expires_at
	].filter((value): value is string => value !== null);
	if (candidates.length === 0) return null;
	return candidates.reduce((earliest, value) =>
		value < earliest ? value : earliest
	);
};

export const purgeOps = (
	internals: FileInternals
): Pick<FilesShape, 'purgeOne' | 'sweepPurges'> => {
	const { sql, blobs, org, sendPurgeJob } = internals;
	const storage = (operation: string) => (cause: unknown) =>
		new StorageError({ operation, cause });

	const claim = (fileId: string, now: string) =>
		sql<{ id: string }>`
			UPDATE files
			SET purge_state = 'pending',
				deleted_at = COALESCE(deleted_at, ${now}),
				purge_at = COALESCE(purge_at, ${now}),
				purge_attempts = purge_attempts + 1,
				purge_error = NULL,
				purge_next_run_at = ${new Date(Date.parse(now) + PURGE_LEASE_MS).toISOString()}
			WHERE id = ${fileId} AND org_id = ${org.id} AND (
				(
					purge_state IN ('none', 'failed')
					AND (purge_next_run_at IS NULL OR purge_next_run_at <= ${now})
					AND (
						(expires_at IS NOT NULL AND expires_at <= ${now})
						OR (deleted_at IS NOT NULL AND purge_at IS NOT NULL AND purge_at <= ${now})
					)
				)
				OR (purge_state = 'pending' AND purge_next_run_at <= ${now})
			)
			RETURNING id`.pipe(
			Effect.map((rows) => rows.length === 1),
			Effect.mapError(storage('claim file purge'))
		);

	const deleteBlobs = (fileId: string) =>
		Effect.all(
			[
				sql<{ version: number; r2_key: string }>`
					SELECT version, r2_key FROM file_versions WHERE file_id = ${fileId}`,
				sql<{ r2_key: string }>`
					SELECT r2_key FROM site_assets WHERE file_id = ${fileId}`
			],
			{ concurrency: 'unbounded' }
		).pipe(
			Effect.mapError(storage('list file purge keys')),
			Effect.flatMap(([versions, assets]) =>
				blobs
					.deleteMany([
						...versions
							.filter((item) => !item.r2_key.startsWith('site-version/'))
							.map((item) => item.r2_key),
						...assets.map((item) => item.r2_key)
					])
					.pipe(
						Effect.andThen(
							blobs.deletePrefixes(
								versions.map((item) =>
									dashboardThumbnailPrefix(fileId, item.version)
								)
							)
						)
					)
			)
		);

	// A failed blob delete keeps the row, backs off on the row's own
	// schedule, and re-sends the job for that moment; the queue's retry
	// budget is reserved for failures that could not even be recorded.
	const recordFailure = (fileId: string, failure: StorageError) =>
		Effect.gen(function* () {
			const attempts = yield* sql<{ purge_attempts: number }>`
				SELECT purge_attempts FROM files WHERE id = ${fileId}`.pipe(
				Effect.map((rows) => rows[0]?.purge_attempts ?? 1)
			);
			const nextRunAt = retryAt(attempts);
			yield* sql`
				UPDATE files
				SET purge_state = 'failed',
					purge_error = ${safeIndexError(failure.cause)},
					purge_next_run_at = ${nextRunAt}
				WHERE id = ${fileId} AND purge_state = 'pending'`;
			return nextRunAt;
		}).pipe(Effect.mapError(storage('record file purge failure')));

	const purgeOne = Effect.fn('Files.purgeOne')(function* (fileId: string) {
		const rows = yield* sql`
			SELECT deleted_at, purge_at, expires_at, purge_state, purge_next_run_at
			FROM files
			WHERE id = ${fileId} AND org_id = ${org.id}
			LIMIT 1`.pipe(Effect.mapError(storage('find file to purge')));
		const decoded = decodePurgeRows(rows);
		const row = decoded._tag === 'Some' ? decoded.value[0] : undefined;
		// Already purged, or restored with no expiry: nothing is owed.
		if (!row) return;
		const dueAt = purgeDueAt(row);
		if (dueAt === null) return;

		const now = new Date().toISOString();
		// Not yet due (the queue caps delays at twelve hours, so long
		// retentions arrive early), or backing off from a failed delete, or
		// leased by another attempt: come back when the row says so.
		const resumeAt = [dueAt, row.purge_next_run_at]
			.filter((value): value is string => value !== null && value > now)
			.sort()
			.at(-1);
		if (resumeAt !== undefined) {
			return yield* sendPurgeJob(fileId, resumeAt);
		}

		const claimed = yield* claim(fileId, now);
		if (!claimed) return;

		const deleted = yield* deleteBlobs(fileId).pipe(
			Effect.as(true),
			Effect.catch((failure) =>
				recordFailure(fileId, failure).pipe(
					Effect.tap((nextRunAt) => sendPurgeJob(fileId, nextRunAt)),
					Effect.as(false)
				)
			)
		);
		if (!deleted) return;

		yield* completePurge(sql, org.id, fileId);
		forgetTagListCache(org.id);
	});

	// Reconciliation: rows whose purge was due long ago and that no
	// attempt is currently leasing lost their delivery; they get a fresh
	// job. Stamping purge_next_run_at keeps one re-send per stuck window.
	const sweepPurges = Effect.fn('Files.sweepPurges')(function* (limit: number) {
		const bounded = Math.max(1, Math.min(limit, 10));
		const now = new Date();
		const cutoff = stuckBefore(now.getTime());
		const rows = yield* sql<{ id: string }>`
			UPDATE files
			SET purge_next_run_at = ${now.toISOString()}
			WHERE id IN (
				SELECT id
				FROM files
				WHERE org_id = ${org.id}
					AND purge_state IN ('none', 'failed', 'pending')
					AND (purge_next_run_at IS NULL OR purge_next_run_at <= ${cutoff})
					AND (
						(expires_at IS NOT NULL AND expires_at <= ${cutoff})
						OR (deleted_at IS NOT NULL AND purge_at IS NOT NULL
							AND purge_at <= ${cutoff})
					)
				ORDER BY COALESCE(purge_at, expires_at), id
				LIMIT ${bounded}
			) AND org_id = ${org.id}
			RETURNING id`.pipe(Effect.mapError(storage('list stuck file purges')));
		for (const row of rows) yield* sendPurgeJob(row.id, now.toISOString());
		return rows.length;
	});

	return { purgeOne, sweepPurges };
};
