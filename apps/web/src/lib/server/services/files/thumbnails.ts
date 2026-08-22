import { dashboardThumbnailPrefix } from '../../../file-thumbnail';
import { InvalidRequest, NotFound, StorageError } from '../../errors';
import {
	commitThumbnailStorageCommand,
	thumbnailQuotaDelta,
	thumbnailStorageStateCommand
} from '../../thumbnail-storage';
import { Effect } from 'effect';
import type { FileInternals } from './internals';
import type { FilesShape } from './types';

export const thumbnailOps = (
	internals: FileInternals
): Pick<FilesShape, 'storeDashboardThumbnail'> => {
	const { db, blobs } = internals;
	const { checkStorageQuota, compensateStoredBlob } = internals;
	return {
		storeDashboardThumbnail: Effect.fn('Files.storeDashboardThumbnail')(
			function* (id, version, body, size, expectedR2Key) {
				const stateCommand = thumbnailStorageStateCommand(id, version);
				const state = yield* Effect.tryPromise({
					try: () =>
						db
							.prepare(stateCommand.sql)
							.bind(...stateCommand.bindings)
							.first<{
								thumbnail_r2_key: string | null;
								thumbnail_size_bytes: number;
							}>(),
					catch: (cause) =>
						new StorageError({
							operation: 'find dashboard thumbnail state',
							cause
						})
				});
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
				const commitCommand = commitThumbnailStorageCommand(
					id,
					version,
					r2Key,
					stored.size,
					expectedR2Key
				);
				const commit = Effect.tryPromise({
					try: () =>
						db
							.prepare(commitCommand.sql)
							.bind(...commitCommand.bindings)
							.run(),
					catch: (cause) =>
						new StorageError({
							operation: 'record dashboard thumbnail',
							cause
						})
				});
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
				if (committed.meta.changes !== 1) {
					yield* compensateStoredBlob(
						new NotFound({ id }),
						id,
						version,
						r2Key,
						'dashboard thumbnail'
					).pipe(Effect.catchTag('NotFound', () => Effect.void));
					const winnerCommand = thumbnailStorageStateCommand(id, version);
					const winner = yield* Effect.tryPromise({
						try: () =>
							db
								.prepare(winnerCommand.sql)
								.bind(...winnerCommand.bindings)
								.first<{ thumbnail_r2_key: string | null }>(),
						catch: (cause) =>
							new StorageError({
								operation: 'find committed dashboard thumbnail',
								cause
							})
					});
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
