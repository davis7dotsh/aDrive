import type { PgClient } from '@effect/sql-pg';
import { Effect } from 'effect';
import { InvalidRequest, StorageError } from './errors';

// Bytes actually held in R2: every version of a regular file is stored,
// a site keeps only its current version's assets (old assets are deleted
// at commit), and assets staged into an uncommitted publish session are
// already in R2 so they must count before the commit creates file rows.
// Concurrent uploads can each pass this check before the other commits —
// for a single-user deployment that bounded overshoot (≤ one upload per
// concurrent request) is accepted; the quota is a safety net, not billing.
// Sites and files both call this before writing bytes.
export const ensureStoredBytesWithin = (
	sql: PgClient.PgClient,
	maxTotalBytes: number,
	incomingBytes: number
) =>
	Effect.gen(function* () {
		const rows = yield* sql<{ total: number }>`
			SELECT
				COALESCE((
					SELECT SUM(v.size_bytes + v.thumbnail_size_bytes)
					FROM file_versions v
					JOIN files f ON f.id = v.file_id
					WHERE f.is_site = false
				), 0)
				+
				COALESCE((
					SELECT SUM(size_bytes) FROM files WHERE is_site = true
				), 0)
				+
				COALESCE((
					SELECT SUM(a.stored_size_bytes)
					FROM staged_site_assets a
					JOIN site_upload_sessions s ON s.id = a.session_id
					WHERE a.stored_size_bytes IS NOT NULL
						AND s.status IN ('open', 'committing')
				), 0)
			AS total`.pipe(
			Effect.mapError(
				(cause) =>
					new StorageError({ operation: 'measure stored bytes', cause })
			)
		);
		const total = rows[0]?.total;
		// Fail closed: an unreadable total must block the upload, not wave
		// it through as if the bucket were empty.
		if (total === undefined || !Number.isFinite(total)) {
			return yield* new StorageError({
				operation: 'measure stored bytes',
				cause: 'Unexpected aggregate result'
			});
		}
		if (total + incomingBytes > maxTotalBytes) {
			return yield* new InvalidRequest({
				status: 413,
				message: 'The storage quota is exhausted'
			});
		}
	}).pipe(Effect.withSpan('StorageQuota.ensure'));
