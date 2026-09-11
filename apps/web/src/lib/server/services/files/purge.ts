import { dashboardThumbnailPrefix } from '../../../file-thumbnail';
import { StorageError } from '../../errors';
import { completePurge } from '../../purge-sql';
import { retryAt, safeIndexError } from '../../semantic-policy';
import { Effect } from 'effect';
import { forgetTagListCache } from '../tags';
import type { FileInternals } from './internals';
import type { FilesShape } from './types';

export const purgeOps = (
	internals: FileInternals
): Pick<FilesShape, 'sweepPurges'> => {
	const { sql, blobs, org } = internals;
	return {
		sweepPurges: Effect.fn('Files.sweepPurges')(function* (limit) {
			const bounded = Math.max(1, Math.min(limit, 10));
			const now = new Date().toISOString();
			const due = yield* sql<{ id: string }>`
				SELECT id
				FROM files
				WHERE org_id = ${org.id} AND ((
					(
						(expires_at IS NOT NULL AND expires_at <= ${now})
						OR (deleted_at IS NOT NULL AND purge_at IS NOT NULL AND purge_at <= ${now})
					)
					AND purge_state IN ('none', 'failed')
					AND (purge_next_run_at IS NULL OR purge_next_run_at <= ${now})
				) OR (
					purge_state = 'pending'
					AND (purge_next_run_at IS NULL OR purge_next_run_at <= ${now})
				))
				ORDER BY COALESCE(purge_at, expires_at), id
				LIMIT ${bounded}
			`.pipe(
				Effect.mapError(
					(cause) =>
						new StorageError({ operation: 'list files due for purge', cause })
				)
			);

			for (const row of due) {
				const leaseUntil = new Date(Date.now() + 5 * 60 * 1_000).toISOString();
				const claimed = yield* sql<{ id: string }>`
					UPDATE files
					SET purge_state = 'pending',
						deleted_at = COALESCE(deleted_at, ${now}),
						purge_at = COALESCE(purge_at, ${now}),
						purge_attempts = purge_attempts + 1,
						purge_error = NULL, purge_next_run_at = ${leaseUntil}
					WHERE id = ${row.id} AND org_id = ${org.id} AND (
						(
							purge_state IN ('none', 'failed')
							AND (
								(expires_at IS NOT NULL AND expires_at <= ${now})
								OR (deleted_at IS NOT NULL AND purge_at IS NOT NULL AND purge_at <= ${now})
							)
						)
						OR (
							purge_state = 'pending'
							AND (purge_next_run_at IS NULL OR purge_next_run_at <= ${now})
						)
					)
					RETURNING id
				`.pipe(
					Effect.mapError(
						(cause) =>
							new StorageError({ operation: 'claim file purge', cause })
					)
				);
				if (claimed.length !== 1) continue;

				const deletion = yield* Effect.all(
					[
						sql<{ version: number; r2_key: string }>`
							SELECT version, r2_key FROM file_versions WHERE file_id = ${row.id}`,
						sql<{ r2_key: string }>`
							SELECT r2_key FROM site_assets WHERE file_id = ${row.id}`
					],
					{ concurrency: 'unbounded' }
				).pipe(
					Effect.map(([versions, assets]) => ({
						keys: [
							...versions
								.filter((item) => !item.r2_key.startsWith('site-version/'))
								.map((item) => item.r2_key),
							...assets.map((item) => item.r2_key)
						],
						thumbnailPrefixes: versions.map((item) =>
							dashboardThumbnailPrefix(row.id, item.version)
						)
					})),
					Effect.mapError(
						(cause) =>
							new StorageError({ operation: 'list file purge keys', cause })
					)
				);

				const deleted = yield* blobs.deleteMany(deletion.keys).pipe(
					Effect.andThen(blobs.deletePrefixes(deletion.thumbnailPrefixes)),
					Effect.as(true),
					Effect.catch((failure) =>
						Effect.gen(function* () {
							const attempts = yield* sql<{ purge_attempts: number }>`
								SELECT purge_attempts FROM files WHERE id = ${row.id}`.pipe(
								Effect.map((rows) => rows[0]?.purge_attempts ?? 1)
							);
							yield* sql`
								UPDATE files
								SET purge_state = 'failed',
									purge_error = ${safeIndexError(failure.cause)},
									purge_next_run_at = ${retryAt(attempts)}
								WHERE id = ${row.id} AND purge_state = 'pending'`;
						}).pipe(
							Effect.mapError(
								(cause) =>
									new StorageError({
										operation: 'record file purge failure',
										cause
									})
							),
							Effect.as(false)
						)
					)
				);
				if (!deleted) continue;

				yield* completePurge(sql, org.id, row.id);
				forgetTagListCache(org.id);
			}
			return due.length;
		})
	} satisfies Pick<FilesShape, 'sweepPurges'>;
};
