import type { PgClient } from '@effect/sql-pg';
import { Effect } from 'effect';
import { StorageError } from './errors';

// Runs after R2 confirmed the blobs are gone. Deleting the files row
// cascades to file_versions, file_tags, site_assets, file_chunks, and
// search_documents, so completion is only the ownership hand-off: mark
// the pending claim done, then drop the row. Both steps must hit exactly
// one row or the transaction rolls back and a later sweep retries.
export const completePurge = (sql: PgClient.PgClient, fileId: string) =>
	sql
		.withTransaction(
			Effect.gen(function* () {
				const done = yield* sql<{ id: string }>`
					UPDATE files
					SET purge_state = 'done', purge_error = NULL, purge_next_run_at = NULL
					WHERE id = ${fileId} AND purge_state = 'pending'
					RETURNING id`;
				const deleted = yield* sql<{ id: string }>`
					DELETE FROM files
					WHERE id = ${fileId} AND purge_state = 'done'
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
