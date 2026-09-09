import { dashboardThumbnailPrefix } from '../../../file-thumbnail';
import { NotFound, StorageError } from '../../errors';
import {
	commitThumbnailStorage,
	thumbnailQuotaDelta,
	thumbnailStorageState
} from '../../thumbnail-storage';
import { Effect } from 'effect';
import type { FileInternals } from './internals';
import type { FilesShape } from './types';

export const thumbnailOps = (
	internals: FileInternals
): Pick<FilesShape, 'storeDashboardThumbnail'> => {
	const { sql, blobs } = internals;
	const { checkStorageQuota, compensateStoredBlob } = internals;
	return {
		storeDashboardThumbnail: Effect.fn('Files.storeDashboardThumbnail')(
			function* (orgId, id, version, body, size, expectedR2Key) {
				const state = yield* thumbnailStorageState(
					sql,
					orgId,
					id,
					version
				).pipe(
					Effect.mapError(
						(cause) =>
							new StorageError({
								operation: 'find dashboard thumbnail state',
								cause
							})
					)
				);
				if (state === null) return yield* new NotFound({ id });
				if (state.thumbnail_r2_key !== expectedR2Key) {
					if (state.thumbnail_r2_key === null) {
						return yield* new NotFound({ id });
					}
					return { _tag: 'Existing', r2Key: state.thumbnail_r2_key } as const;
				}

				yield* checkStorageQuota(
					thumbnailQuotaDelta(state.thumbnail_size_bytes, size)
				);
				const r2Key = `${dashboardThumbnailPrefix(id, version)}${crypto.randomUUID()}.webp`;
				const stored = yield* blobs.put(r2Key, body, size, 'image/webp');
				const commit = commitThumbnailStorage(
					sql,
					orgId,
					id,
					version,
					r2Key,
					stored.size,
					expectedR2Key
				).pipe(
					Effect.mapError(
						(cause) =>
							new StorageError({
								operation: 'record dashboard thumbnail',
								cause
							})
					)
				);
				const committed = yield* commit.pipe(
					Effect.catch((failure) =>
						compensateStoredBlob(
							failure,
							id,
							version,
							r2Key,
							'dashboard thumbnail'
						)
					)
				);
				if (!committed) {
					yield* compensateStoredBlob(
						new NotFound({ id }),
						id,
						version,
						r2Key,
						'dashboard thumbnail'
					).pipe(Effect.catchTag('NotFound', () => Effect.void));
					const winner = yield* thumbnailStorageState(
						sql,
						orgId,
						id,
						version
					).pipe(
						Effect.mapError(
							(cause) =>
								new StorageError({
									operation: 'find committed dashboard thumbnail',
									cause
								})
						)
					);
					if (winner === null || winner.thumbnail_r2_key === null) {
						return yield* new NotFound({ id });
					}
					return {
						_tag: 'Existing',
						r2Key: winner.thumbnail_r2_key
					} as const;
				}
				return { _tag: 'Stored', blob: stored } as const;
			}
		)
	} satisfies Pick<FilesShape, 'storeDashboardThumbnail'>;
};
