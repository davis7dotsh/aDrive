import { Effect } from 'effect';
import { InvalidRequest, StorageError } from './errors';

// Bytes actually held in R2: every version of a regular file is stored,
// but a site keeps only its current version's assets (old assets are
// deleted at commit), so superseded site version rows must not count.
// Concurrent uploads can each pass this check before the other commits —
// for a single-user deployment that bounded overshoot (≤ one upload per
// concurrent request) is accepted; the quota is a safety net, not billing.
const TOTAL_STORED_BYTES_SQL = `
	SELECT
		COALESCE((
			SELECT SUM(v.size_bytes)
			FROM file_versions v
			JOIN files f ON f.id = v.file_id
			WHERE f.is_site = 0
		), 0)
		+
		COALESCE((
			SELECT SUM(size_bytes) FROM files WHERE is_site = 1
		), 0)
	AS total`;

export const ensureStorageQuota = (
	db: D1Database,
	maxTotalBytes: number,
	incomingBytes: number
) =>
	Effect.gen(function* () {
		const row = yield* Effect.tryPromise({
			try: () => db.prepare(TOTAL_STORED_BYTES_SQL).first<{ total: number }>(),
			catch: (cause) =>
				new StorageError({ operation: 'measure stored bytes', cause })
		});
		// Fail closed: an unreadable total must block the upload, not wave
		// it through as if the bucket were empty.
		if (row === null || !Number.isFinite(row.total)) {
			return yield* new StorageError({
				operation: 'measure stored bytes',
				cause: 'Unexpected aggregate result'
			});
		}
		if (row.total + incomingBytes > maxTotalBytes) {
			return yield* new InvalidRequest({
				status: 413,
				message: 'The storage quota is exhausted'
			});
		}
	}).pipe(Effect.withSpan('StorageQuota.ensure'));
