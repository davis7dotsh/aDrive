import { Effect } from 'effect';
import { InvalidRequest, NotFound, StorageError } from '../../errors';
import {
	cleanFileName,
	trashWindow,
	visibilityForFile
} from '../../file-policy';
import { refreshSearchDocument } from '../../search-index';
import { markScanPending } from '../../scan-jobs';
import { tenantOrgId } from '../current-org';
import type { FileInternals } from './internals';
import type { FilesShape, MutationResult } from './types';

const EPOCH = '1970-01-01T00:00:00.000Z';

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
	const { sql, org } = internals;
	const {
		ensurePublishAllowed,
		refuseQuarantined,
		findDashboardFile,
		sendIndexJob,
		sendPurgeJob,
		sendScanJob
	} = internals;
	return {
		setVisibility: Effect.fn('Files.setVisibility')(function* (id, isPublic) {
			const changed = yield* sql
				.withTransaction(
					Effect.gen(function* () {
						// Serialize with version publication and scanner decisions before
						// deriving visibility from the current row.
						const current = yield* findDashboardFile(id, true);
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
						const publishing = visibility.public && !current.public;
						if (publishing) yield* refuseQuarantined(current);
						const hold = yield* ensurePublishAllowed(publishing);
						const isPublicNow = visibility.public && !hold;
						const updatedAt = new Date().toISOString();
						yield* sql`
						UPDATE files
						SET public = ${isPublicNow}, publish_pending = ${hold},
							updated_at = ${updatedAt}
						WHERE id = ${id} AND org_id = ${org.id}`;
						if (visibility.public) {
							yield* markScanPending(sql, org.id, id, current.version);
						}
						return {
							scan: visibility.public,
							result: {
								file: {
									...current,
									public: isPublicNow,
									publishPending: hold,
									updatedAt
								},
								forcedPublic: visibility.forcedPublic
							} satisfies MutationResult
						};
					})
				)
				.pipe(
					Effect.catchTag('SqlError', (cause) =>
						Effect.fail(
							new StorageError({ operation: 'update file visibility', cause })
						)
					)
				);
			if (changed.scan) yield* sendScanJob(id, changed.result.file.version);
			return changed.result;
		}),
		trash: Effect.fn('Files.trash')(function* (id) {
			const current = yield* findDashboardFile(id);
			const { deletedAt, purgeAt } = trashWindow(current.deletedAt, new Date());
			const rows = yield* sql<{ id: string }>`
				UPDATE files
				SET deleted_at = ${deletedAt}, purge_at = ${purgeAt}, purge_state = 'none',
					purge_error = NULL, purge_next_run_at = NULL, updated_at = ${deletedAt}
				WHERE id = ${id} AND org_id = ${org.id} AND purge_state <> 'pending'
				RETURNING id
			`.pipe(
				Effect.mapError(
					(cause) => new StorageError({ operation: 'trash file', cause })
				)
			);
			if (rows.length !== 1) {
				return yield* new NotFound({ id });
			}
			yield* sendPurgeJob(id, purgeAt);
			return {
				file: { ...current, deletedAt, updatedAt: deletedAt },
				forcedPublic: false
			};
		}),
		restore: Effect.fn('Files.restore')(function* (id) {
			const current = yield* findDashboardFile(id);
			const updatedAt = new Date().toISOString();
			// A failed purge may already have deleted originals before a later
			// blob or thumbnail operation failed. Once deletion has started,
			// keep the row in trash until cleanup finishes; resetting its state
			// through another trash action must not make it restorable either.
			const rows = yield* sql<{ id: string }>`
				UPDATE files
				SET deleted_at = NULL, purge_at = NULL, purge_state = 'none',
					purge_error = NULL, purge_next_run_at = NULL,
					updated_at = ${updatedAt}
				WHERE id = ${id} AND org_id = ${org.id}
					AND purge_state = 'none' AND purge_attempts = 0
				RETURNING id
			`.pipe(
				Effect.mapError(
					(cause) => new StorageError({ operation: 'restore file', cause })
				)
			);
			if (rows.length !== 1) {
				return yield* new InvalidRequest({
					status: 409,
					message: 'This file has already started permanent deletion'
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
				WHERE id = ${id} AND org_id = ${org.id}
			`.pipe(
				Effect.mapError(
					(cause) =>
						new StorageError({ operation: 'update file expiration', cause })
				)
			);
			if (expiresAt !== null) yield* sendPurgeJob(id, expiresAt);
			return {
				file: { ...current, expiresAt, updatedAt },
				forcedPublic: false
			};
		}),
		rename: Effect.fn('Files.rename')(function* (id, value) {
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
			const changed = yield* sql
				.withTransaction(
					Effect.gen(function* () {
						const current = yield* findDashboardFile(id, true);
						const visibility = visibilityForFile(
							displayName,
							current.contentType,
							current.public || current.publishPending
						);
						const publishing = visibility.public && !current.public;
						if (publishing) yield* refuseQuarantined(current);
						const hold = yield* ensurePublishAllowed(publishing);
						const isPublicNow = visibility.public && !hold;
						const updatedAt = new Date().toISOString();
						yield* sql`
						UPDATE files
						SET display_name = ${displayName}, public = ${isPublicNow},
							publish_pending = ${hold},
							updated_at = ${updatedAt}, index_state = 'pending',
							index_cursor = 0, index_attempts = 0, index_error = NULL,
							index_next_run_at = NULL, index_lease_token = NULL
						WHERE id = ${id} AND org_id = ${org.id}`;
						yield* refreshSearchDocument(sql, id, org.id);
						if (publishing)
							yield* markScanPending(sql, org.id, id, current.version);
						return {
							scan: publishing,
							result: {
								file: {
									...current,
									displayName,
									public: isPublicNow,
									publishPending: hold,
									htmlForcedPublic:
										current.htmlForcedPublic || /\.html?$/i.test(displayName),
									updatedAt,
									indexState: 'pending',
									indexAttempts: 0,
									indexError: null
								},
								forcedPublic: visibility.forcedPublic
							} satisfies MutationResult
						};
					})
				)
				.pipe(
					Effect.catchTag('SqlError', (cause) =>
						Effect.fail(new StorageError({ operation: 'rename file', cause }))
					)
				);
			yield* sendIndexJob(id, changed.result.file.version);
			if (changed.scan) yield* sendScanJob(id, changed.result.file.version);
			return changed.result;
		}),
		schedulePurgeNow: Effect.fn('Files.schedulePurgeNow')(function* (id) {
			const current = yield* findDashboardFile(id);
			if (!current.deletedAt) {
				return yield* new InvalidRequest({
					status: 409,
					message: 'Move the file to trash before deleting it permanently'
				});
			}
			const rows = yield* sql<{ id: string }>`
				UPDATE files
				SET purge_at = ${EPOCH}, purge_state = 'none', purge_error = NULL,
					purge_next_run_at = NULL
				WHERE id = ${id} AND org_id = ${org.id} AND deleted_at IS NOT NULL
					AND purge_state <> 'pending'
				RETURNING id
			`.pipe(
				Effect.mapError(
					(cause) =>
						new StorageError({ operation: 'schedule immediate purge', cause })
				)
			);
			if (rows.length !== 1) {
				return yield* new InvalidRequest({
					status: 409,
					message: 'This file is already being purged'
				});
			}
			yield* sendPurgeJob(id, EPOCH);
			return { file: current, forcedPublic: false };
		}),
		// A generator body reads the org when the effect runs, not when the
		// layer is built (content routes build the layer with no tenant).
		scheduleAllPurgesNow: Effect.gen(function* () {
			const rows = yield* sql<{ count: number; ids: string[] }>`
				WITH scheduled AS (
					UPDATE files
					SET purge_at = ${EPOCH}, purge_state = 'none', purge_error = NULL,
						purge_next_run_at = NULL
					WHERE org_id = ${org.id} AND deleted_at IS NOT NULL
						AND purge_state <> 'pending'
					RETURNING id
				)
				SELECT count(*)::int AS count,
					ARRAY(SELECT id FROM scheduled LIMIT 20) AS ids
				FROM scheduled
			`.pipe(
				Effect.mapError(
					(cause) =>
						new StorageError({ operation: 'schedule empty trash', cause })
				)
			);
			// All work is durable in Postgres. Kick a small batch now; the
			// bounded reconciliation sweep picks up the rest or a slow send.
			yield* Effect.forEach(
				rows[0]?.ids ?? [],
				(id) => sendPurgeJob(id, EPOCH),
				{
					concurrency: 5,
					discard: true
				}
			).pipe(Effect.timeoutOption('5 seconds'));
			return rows[0]?.count ?? 0;
		}).pipe(Effect.withSpan('Files.scheduleAllPurgesNow')),
		recordDownload: Effect.fn('Files.recordDownload')(function* (id) {
			const now = new Date().toISOString();
			// Content routes have no tenant; the file id alone identifies it.
			const orgId = tenantOrgId(org);
			yield* sql`
				UPDATE files
				SET download_count = download_count + 1, last_download_at = ${now}
				WHERE id = ${id} AND (${orgId}::text IS NULL OR org_id = ${orgId})
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
