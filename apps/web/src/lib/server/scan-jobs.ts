import type { PgClient } from '@effect/sql-pg';
import { Effect } from 'effect';
import { StorageError } from './errors';
import { STUCK_JOB_MS } from './job-policy';
import type { JobQueue } from './services/jobs';

const storageError = (operation: string) =>
	Effect.mapError((cause: unknown) => new StorageError({ operation, cause }));

// Called inside the metadata transaction that requires the scan, after
// the version exists. A failed queue send cannot lose this obligation.
export const markScanPending = (
	sql: PgClient.PgClient,
	orgId: string,
	fileId: string,
	version: number
) =>
	sql`
		UPDATE file_versions
		SET scan_next_run_at = clock_timestamp() + ${STUCK_JOB_MS} * interval '1 millisecond'
		WHERE file_id = ${fileId} AND org_id = ${orgId} AND version = ${version}
	`.pipe(Effect.asVoid, storageError('request content scan'));

export const recoverScanJobs = (
	sql: PgClient.PgClient,
	jobs: JobQueue['Service'],
	orgId: string,
	limit: number
) =>
	Effect.gen(function* () {
		const bounded = Math.max(1, Math.min(limit, 100));
		const rows = yield* sql<{ file_id: string; version: number }>`
			UPDATE file_versions v
			SET scan_next_run_at = clock_timestamp() + ${STUCK_JOB_MS} * interval '1 millisecond'
			WHERE (v.file_id, v.version) IN (
				SELECT due.file_id, due.version
				FROM file_versions due
				JOIN files f ON f.id = due.file_id AND f.org_id = due.org_id
				WHERE due.org_id = ${orgId} AND due.scan_next_run_at <= now()
					AND f.deleted_at IS NULL
					AND (f.expires_at IS NULL OR f.expires_at > now())
					AND (NOT f.is_site OR f.current_version = due.version)
				ORDER BY due.scan_next_run_at, due.file_id, due.version
				LIMIT ${bounded}
				FOR UPDATE OF due SKIP LOCKED
			) AND v.org_id = ${orgId}
			RETURNING file_id, version
		`.pipe(storageError('recover content scans'));
		for (const row of rows) {
			yield* jobs.trySend({
				kind: 'scan',
				orgId,
				fileId: row.file_id,
				version: row.version
			});
		}
		return rows.length;
	});
