import type { PgClient } from '@effect/sql-pg';
import { Effect } from 'effect';
import { StorageError } from './errors';
import { releaseStoredBytes } from './storage-quota';

// Runs after R2 confirmed the blobs are gone. Deleting the files row
// cascades to file_versions, file_tags, site_assets, file_chunks, and
// search_documents, so completion is only the ownership hand-off: mark
// the pending claim done, hand the bytes back to the org, then drop the
// row. Both steps must hit exactly one row or the transaction rolls back
// and a later sweep retries.
export const completePurge = (
	sql: PgClient.PgClient,
	orgId: string,
	fileId: string
) =>
	sql
		.withTransaction(
			Effect.gen(function* () {
				const done = yield* sql<{ id: string }>`
					UPDATE files
					SET purge_state = 'done', purge_error = NULL, purge_next_run_at = NULL
					WHERE id = ${fileId} AND org_id = ${orgId} AND purge_state = 'pending'
					RETURNING id`;
				// A site's row carries its asset total; file versions carry
				// their own bytes. Both kinds charge thumbnails per version.
				const held = yield* sql<{ bytes: number }>`
					SELECT (CASE WHEN f.is_site THEN f.size_bytes ELSE 0 END)
						+ COALESCE((
							SELECT SUM(
								(CASE WHEN f.is_site THEN 0 ELSE v.size_bytes END)
								+ v.thumbnail_size_bytes
							)
							FROM file_versions v
							WHERE v.file_id = f.id AND v.org_id = ${orgId}
						), 0) AS bytes
					FROM files f
					WHERE f.id = ${fileId} AND f.org_id = ${orgId}`;
				yield* releaseStoredBytes(sql, orgId, held[0]?.bytes ?? 0);
				const deleted = yield* sql<{ id: string }>`
					DELETE FROM files
					WHERE id = ${fileId} AND org_id = ${orgId} AND purge_state = 'done'
					RETURNING id`;
				if (done.length !== 1 || deleted.length !== 1) {
					return yield* new StorageError({
						operation: 'finish file purge',
						cause: 'File purge state changed before completion'
					});
				}
			})
		)
		.pipe(
			Effect.catchTag('SqlError', (cause) =>
				Effect.fail(new StorageError({ operation: 'finish file purge', cause }))
			)
		);
