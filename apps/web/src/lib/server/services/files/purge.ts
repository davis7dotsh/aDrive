import { dashboardThumbnailPrefix } from '../../../file-thumbnail';
import { StorageError } from '../../errors';
import { purgeCompletionCommands } from '../../purge-sql';
import { retryAt, safeIndexError } from '../../semantic-policy';
import { Effect } from 'effect';
import { forgetTagListCache } from '../tags';
import type { FileInternals } from './internals';
import type { FilesShape } from './types';

export const purgeOps = (
	internals: FileInternals
): Pick<FilesShape, 'sweepPurges'> => {
	const { db, blobs } = internals;
	const { preparePurgeCommand } = internals;
	return {
		sweepPurges: Effect.fn('Files.sweepPurges')(function* (limit) {
			const bounded = Math.max(1, Math.min(limit, 10));
			const now = new Date().toISOString();
			const due = yield* Effect.tryPromise({
				try: async () => {
					const result = await db
						.prepare(
							`SELECT id
							FROM files
							WHERE (
								(
									(expires_at IS NOT NULL AND expires_at <= ?)
									OR (deleted_at IS NOT NULL AND purge_at IS NOT NULL AND purge_at <= ?)
								)
								AND purge_state IN ('none', 'failed')
								AND (purge_next_run_at IS NULL OR purge_next_run_at <= ?)
							) OR (
								purge_state = 'pending'
								AND (purge_next_run_at IS NULL OR purge_next_run_at <= ?)
							)
							ORDER BY COALESCE(purge_at, expires_at), id
							LIMIT ?`
						)
						.bind(now, now, now, now, bounded)
						.all<{ id: string }>();
					if (!result.success)
						throw new Error(result.error ?? 'Purge listing failed');
					return result.results;
				},
				catch: (cause) =>
					new StorageError({ operation: 'list files due for purge', cause })
			});

			for (const row of due) {
				const claimed = yield* Effect.tryPromise({
					try: () =>
						db
							.prepare(
								`UPDATE files
								SET purge_state = 'pending',
									deleted_at = COALESCE(deleted_at, ?),
									purge_at = COALESCE(purge_at, ?),
									purge_attempts = purge_attempts + 1,
									purge_error = NULL, purge_next_run_at = ?
								WHERE id = ? AND (
									(
										purge_state IN ('none', 'failed')
										AND (
											(expires_at IS NOT NULL AND expires_at <= ?)
											OR (deleted_at IS NOT NULL AND purge_at IS NOT NULL AND purge_at <= ?)
										)
									)
									OR (
										purge_state = 'pending'
										AND (purge_next_run_at IS NULL OR purge_next_run_at <= ?)
									)
								)`
							)
							.bind(
								now,
								now,
								new Date(Date.now() + 5 * 60 * 1_000).toISOString(),
								row.id,
								now,
								now,
								now
							)
							.run(),
					catch: (cause) =>
						new StorageError({ operation: 'claim file purge', cause })
				});
				if (claimed.meta.changes !== 1) continue;

				const deletion = yield* Effect.tryPromise({
					try: async () => {
						const [versions, assets] = await Promise.all([
							db
								.prepare(
									`SELECT version, r2_key
									FROM file_versions
									WHERE file_id = ?`
								)
								.bind(row.id)
								.all<{ version: number; r2_key: string }>(),
							db
								.prepare('SELECT r2_key FROM site_assets WHERE file_id = ?')
								.bind(row.id)
								.all<{ r2_key: string }>()
						]);
						if (!versions.success || !assets.success) {
							throw new Error(
								versions.error ?? assets.error ?? 'Purge key listing failed'
							);
						}
						return {
							keys: [
								...versions.results
									.filter((item) => !item.r2_key.startsWith('site-version/'))
									.map((item) => item.r2_key),
								...assets.results.map((item) => item.r2_key)
							],
							thumbnailPrefixes: versions.results.map((item) =>
								dashboardThumbnailPrefix(row.id, item.version)
							)
						};
					},
					catch: (cause) =>
						new StorageError({ operation: 'list file purge keys', cause })
				});

				const deleted = yield* blobs.deleteMany(deletion.keys).pipe(
					Effect.andThen(blobs.deletePrefixes(deletion.thumbnailPrefixes)),
					Effect.as(true),
					Effect.catch((failure) =>
						Effect.tryPromise({
							try: async () => {
								const attempts =
									(
										await db
											.prepare('SELECT purge_attempts FROM files WHERE id = ?')
											.bind(row.id)
											.first<{ purge_attempts: number }>()
									)?.purge_attempts ?? 1;
								await db
									.prepare(
										`UPDATE files
										SET purge_state = 'failed', purge_error = ?,
											purge_next_run_at = ?
										WHERE id = ? AND purge_state = 'pending'`
									)
									.bind(
										safeIndexError(failure.cause),
										retryAt(attempts),
										row.id
									)
									.run();
							},
							catch: (cause) =>
								new StorageError({
									operation: 'record file purge failure',
									cause
								})
						}).pipe(Effect.as(false))
					)
				);
				if (!deleted) continue;

				yield* Effect.tryPromise({
					try: async () => {
						const results = await db.batch(
							purgeCompletionCommands(row.id, now).map(preparePurgeCommand)
						);
						if (
							results[3]?.meta.changes !== 1 ||
							results[4]?.meta.changes !== 1
						) {
							throw new Error('File purge state changed before completion');
						}
					},
					catch: (cause) =>
						new StorageError({ operation: 'finish file purge', cause })
				});
				forgetTagListCache(db);
			}
			return due.length;
		})
	} satisfies Pick<FilesShape, 'sweepPurges'>;
};
