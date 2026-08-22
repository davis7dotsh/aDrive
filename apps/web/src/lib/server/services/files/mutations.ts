import { Effect } from 'effect';
import { InvalidRequest, NotFound, StorageError } from '../../errors';
import {
	cleanFileName,
	trashWindow,
	visibilityForFile
} from '../../file-policy';
import { fileIndexStatements } from '../../search-index';
import type { FileInternals } from './internals';
import type { FilesShape } from './types';

export const mutationOps = (
	internals: FileInternals
): Pick<
	FilesShape,
	| 'setVisibility'
	| 'trash'
	| 'restore'
	| 'setExpiration'
	| 'rename'
	| 'schedulePurgeNow'
	| 'scheduleAllPurgesNow'
	| 'recordDownload'
> => {
	const { db, sql } = internals;
	const { findDashboardFile } = internals;
	return {
		setVisibility: Effect.fn('Files.setVisibility')(function* (id, isPublic) {
			const current = yield* findDashboardFile(id);
			if (current.kind === 'site' && !isPublic) {
				return yield* new InvalidRequest({
					status: 400,
					message: 'Sites are always public'
				});
			}
			const visibility = visibilityForFile(
				current.displayName,
				current.htmlForcedPublic ? 'text/html' : current.contentType,
				isPublic
			);
			const updatedAt = new Date().toISOString();
			yield* sql`
				UPDATE files
				SET public = ${visibility.public ? 1 : 0}, updated_at = ${updatedAt}
				WHERE id = ${id}
			`.pipe(
				Effect.mapError(
					(cause) =>
						new StorageError({ operation: 'update file visibility', cause })
				)
			);
			return {
				file: {
					...current,
					public: visibility.public,
					updatedAt
				},
				forcedPublic: visibility.forcedPublic
			};
		}),
		trash: Effect.fn('Files.trash')(function* (id) {
			const current = yield* findDashboardFile(id);
			const { deletedAt, purgeAt } = trashWindow(current.deletedAt, new Date());
			const result = yield* Effect.tryPromise({
				try: () =>
					db
						.prepare(
							`UPDATE files
							SET deleted_at = ?, purge_at = ?, purge_state = 'none',
								purge_error = NULL, purge_next_run_at = NULL, updated_at = ?
							WHERE id = ? AND purge_state <> 'pending'`
						)
						.bind(deletedAt, purgeAt, deletedAt, id)
						.run(),
				catch: (cause) => new StorageError({ operation: 'trash file', cause })
			});
			if (result.meta.changes !== 1) {
				return yield* new NotFound({ id });
			}
			return {
				file: { ...current, deletedAt, updatedAt: deletedAt },
				forcedPublic: false
			};
		}),
		restore: Effect.fn('Files.restore')(function* (id) {
			const current = yield* findDashboardFile(id);
			const updatedAt = new Date().toISOString();
			const result = yield* Effect.tryPromise({
				try: () =>
					db
						.prepare(
							`UPDATE files
							SET deleted_at = NULL, purge_at = NULL, purge_state = 'none',
								purge_error = NULL, purge_next_run_at = NULL,
								updated_at = ?
							WHERE id = ? AND purge_state <> 'pending'`
						)
						.bind(updatedAt, id)
						.run(),
				catch: (cause) => new StorageError({ operation: 'restore file', cause })
			});
			if (result.meta.changes !== 1) {
				return yield* new InvalidRequest({
					status: 409,
					message: 'This file is already being purged'
				});
			}
			return {
				file: { ...current, deletedAt: null, updatedAt },
				forcedPublic: false
			};
		}),
		setExpiration: Effect.fn('Files.setExpiration')(function* (id, expiresAt) {
			const current = yield* findDashboardFile(id);
			const updatedAt = new Date().toISOString();
			yield* sql`
				UPDATE files
				SET expires_at = ${expiresAt}, updated_at = ${updatedAt}
				WHERE id = ${id}
			`.pipe(
				Effect.mapError(
					(cause) =>
						new StorageError({ operation: 'update file expiration', cause })
				)
			);
			return {
				file: { ...current, expiresAt, updatedAt },
				forcedPublic: false
			};
		}),
		rename: Effect.fn('Files.rename')(function* (id, value) {
			const current = yield* findDashboardFile(id);
			const displayName = yield* Effect.try({
				try: () => cleanFileName(value),
				catch: (cause) =>
					cause instanceof InvalidRequest
						? cause
						: new InvalidRequest({
								status: 400,
								message: 'File name is invalid'
							})
			});
			const visibility = visibilityForFile(
				displayName,
				current.contentType,
				current.public
			);
			const updatedAt = new Date().toISOString();
			yield* Effect.tryPromise({
				try: () =>
					db.batch([
						db
							.prepare(
								`UPDATE files
								SET display_name = ?, public = ?, updated_at = ?,
									index_state = 'pending', index_cursor = 0,
									index_attempts = 0, index_error = NULL,
									index_next_run_at = NULL, index_lease_token = NULL
								WHERE id = ?`
							)
							.bind(displayName, visibility.public ? 1 : 0, updatedAt, id),
						...fileIndexStatements(db, id)
					]),
				catch: (cause) => new StorageError({ operation: 'rename file', cause })
			});
			return {
				file: {
					...current,
					displayName,
					public: visibility.public,
					htmlForcedPublic:
						current.htmlForcedPublic || /\.html?$/i.test(displayName),
					updatedAt,
					indexState: 'pending',
					indexAttempts: 0,
					indexError: null
				},
				forcedPublic: visibility.forcedPublic
			};
		}),
		schedulePurgeNow: Effect.fn('Files.schedulePurgeNow')(function* (id) {
			const current = yield* findDashboardFile(id);
			if (!current.deletedAt) {
				return yield* new InvalidRequest({
					status: 409,
					message: 'Move the file to trash before deleting it permanently'
				});
			}
			const result = yield* Effect.tryPromise({
				try: () =>
					db
						.prepare(
							`UPDATE files
							SET purge_at = ?, purge_state = 'none', purge_error = NULL,
								purge_next_run_at = NULL
							WHERE id = ? AND deleted_at IS NOT NULL
								AND purge_state <> 'pending'`
						)
						.bind('1970-01-01T00:00:00.000Z', id)
						.run(),
				catch: (cause) =>
					new StorageError({ operation: 'schedule immediate purge', cause })
			});
			if (result.meta.changes !== 1) {
				return yield* new InvalidRequest({
					status: 409,
					message: 'This file is already being purged'
				});
			}
			return { file: current, forcedPublic: false };
		}),
		scheduleAllPurgesNow: Effect.tryPromise({
			try: async () => {
				const result = await db
					.prepare(
						`UPDATE files
						SET purge_at = ?, purge_state = 'none', purge_error = NULL,
							purge_next_run_at = NULL
						WHERE deleted_at IS NOT NULL AND purge_state <> 'pending'`
					)
					.bind('1970-01-01T00:00:00.000Z')
					.run();
				return result.meta.changes;
			},
			catch: (cause) =>
				new StorageError({ operation: 'schedule empty trash', cause })
		}).pipe(Effect.withSpan('Files.scheduleAllPurgesNow')),
		recordDownload: Effect.fn('Files.recordDownload')(function* (id) {
			const now = new Date().toISOString();
			yield* sql`
				UPDATE files
				SET download_count = download_count + 1, last_download_at = ${now}
				WHERE id = ${id}
			`.pipe(
				Effect.mapError(
					(cause) =>
						new StorageError({ operation: 'record file download', cause })
				)
			);
		})
	} satisfies Pick<
		FilesShape,
		| 'setVisibility'
		| 'trash'
		| 'restore'
		| 'setExpiration'
		| 'rename'
		| 'schedulePurgeNow'
		| 'scheduleAllPurgesNow'
		| 'recordDownload'
	>;
};
