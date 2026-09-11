import type { DashboardFile } from '@adrive/shared';
import type { PgClient } from '@effect/sql-pg';
import { Effect } from 'effect';
import {
	compensateBlobFailure,
	queueDeferredBlobDelete
} from '../../blob-compensation';
import { InvalidRequest, NotFound, StorageError } from '../../errors';
import {
	dashboardFileColumns,
	decodeDashboardRows,
	toDashboardFile
} from '../../file-rows';
import { visibilityForFile } from '../../file-policy';
import { delaySecondsUntil } from '../../job-policy';
import { refreshSearchDocument } from '../../search-index';
import { markScanPending } from '../../scan-jobs';
import { ensureStorageHeadroom, reserveWithinPlan } from '../../storage-quota';
import { requirePublishAllowed } from '../../trust';
import { scanBeforePublish } from '../../trust-policy';
import type { AppConfig } from '../../config';
import type { Blobs } from '../blobs';
import type { JobQueue } from '../jobs';
import type { Tags } from '../tags';
import type { CurrentOrg } from '../current-org';
import type { MutationResult } from './types';

export interface CoreDeps {
	readonly sql: PgClient.PgClient;
	readonly blobs: Blobs['Service'];
	readonly config: AppConfig['Service'];
	readonly tags: Tags['Service'];
	readonly org: CurrentOrg['Service'];
	readonly jobs: JobQueue['Service'];
}

export const createInternals = (deps: CoreDeps) => {
	const { sql, blobs, config, tags, org, jobs } = deps;
	const compensateStoredBlob = <OriginalError>(
		failure: OriginalError,
		fileId: string,
		version: number,
		r2Key: string,
		operation: string
	) =>
		compensateBlobFailure(
			failure,
			blobs.delete(r2Key),
			(deleteCause) =>
				queueDeferredBlobDelete(
					sql,
					r2Key,
					fileId,
					version,
					new Date().toISOString(),
					String(deleteCause)
				).pipe(
					Effect.mapError(
						(cause) =>
							new StorageError({ operation: 'queue orphaned file blob', cause })
					)
				),
			(deleteCause, queueCause) => {
				console.error(
					JSON.stringify({
						message: `${operation} compensation could not be recorded`,
						r2Key,
						deleteCause: String(deleteCause),
						queueCause: String(queueCause)
					})
				);
			}
		);

	// Every path that turns a file public passes through here first; a
	// `new` org is refused with the message that tells it what to do.
	// Returns whether the publish must wait for the scanner (the caller
	// then holds the row with publish_pending instead of flipping public).
	const ensurePublishAllowed = (becomesPublic: boolean) =>
		becomesPublic
			? Effect.map(requirePublishAllowed(sql, org.id), scanBeforePublish)
			: Effect.succeed(false);

	const refuseQuarantined = (file: { readonly quarantined: boolean }) =>
		file.quarantined
			? Effect.fail(
					new InvalidRequest({
						status: 403,
						message: 'This file was quarantined and cannot be changed'
					})
				)
			: Effect.void;

	// Cheap read before a body streams; the reservation inside the commit
	// transaction is what actually holds the bytes.
	const ensureHeadroom = (incomingBytes: number) =>
		ensureStorageHeadroom(sql, org.id, incomingBytes);
	const reserveBytes = (orgId: string, delta: number) =>
		reserveWithinPlan(sql, orgId, delta);

	// Sent after the transaction that made the work necessary has
	// committed; a lost send is caught by the cron reconciliation.
	const sendIndexJob = (fileId: string, version: number) =>
		jobs.trySend({ kind: 'index', orgId: org.id, fileId, version });
	// Delayed until the row's deadline (capped by the queue; the job
	// re-sends itself with the remainder when it arrives early).
	const sendPurgeJob = (fileId: string, dueAt: string) =>
		jobs.trySend(
			{ kind: 'purge', orgId: org.id, fileId },
			{ delaySeconds: delaySecondsUntil(dueAt) }
		);
	// Every version that is (or is about to be) public is scanned; the
	// scanner publishes a held row itself (services/scanner.ts).
	const sendScanJob = (fileId: string, version: number) =>
		jobs.trySend({ kind: 'scan', orgId: org.id, fileId, version });

	const findDashboardFile = Effect.fn('Files.findDashboardFile')(function* (
		id: string,
		lock = false
	) {
		if (lock) {
			// Keep the lock separate from the read so correlated version/tag
			// queries also see what a concurrent writer committed while waiting.
			yield* sql`
				SELECT id FROM files WHERE id = ${id} AND org_id = ${org.id}
				FOR UPDATE`.pipe(
				Effect.mapError(
					(cause) =>
						new StorageError({ operation: 'lock dashboard file', cause })
				)
			);
		}
		const rows = yield* sql`
			SELECT ${sql.literal(dashboardFileColumns)}
			FROM files f
			WHERE f.id = ${id} AND f.org_id = ${org.id}
			LIMIT 1`.pipe(
			Effect.mapError(
				(cause) => new StorageError({ operation: 'find dashboard file', cause })
			)
		);
		const row = decodeDashboardRows(rows)[0];
		if (!row) return yield* new NotFound({ id });
		return {
			...toDashboardFile(row),
			quarantined: row.quarantined,
			publishPending: row.publish_pending
		};
	});

	const commitStoredVersion = Effect.fn('Files.commitStoredVersion')(function* (
		current: DashboardFile & { readonly quarantined: boolean },
		r2Key: string,
		size: number,
		contentType: string
	) {
		yield* refuseQuarantined(current);
		const version = current.version + 1;
		const committed = yield* sql
			.withTransaction(
				Effect.gen(function* () {
					// Re-read after locking: visibility, a pending publication,
					// or quarantine may have changed while the body streamed.
					const latest = yield* findDashboardFile(current.id, true);
					yield* refuseQuarantined(latest);
					const updatedAt = new Date().toISOString();
					const visibility = visibilityForFile(
						latest.displayName,
						latest.htmlForcedPublic ? 'text/html' : contentType,
						latest.public || latest.publishPending
					);
					// Every new public version needs its own scan, including a
					// replacement while the previous publication is still held.
					const hold = yield* ensurePublishAllowed(visibility.public);
					const isPublicNow = visibility.public && !hold;
					const updated = yield* sql<{ id: string }>`
						UPDATE files
						SET current_version = ${version}, size_bytes = ${size},
							content_type = ${contentType}, public = ${isPublicNow},
							publish_pending = ${hold},
							updated_at = ${updatedAt}, index_state = 'pending',
							index_cursor = 0, index_attempts = 0, index_error = NULL,
							index_next_run_at = NULL, index_lease_token = NULL
						WHERE id = ${current.id} AND org_id = ${org.id}
							AND current_version = ${current.version}
							AND deleted_at IS NULL
						RETURNING id`;
					if (updated.length !== 1) {
						return yield* new StorageError({
							operation: 'commit file version',
							cause: 'File changed while the version was uploading'
						});
					}
					yield* sql`
							INSERT INTO file_versions (
								file_id, org_id, version, r2_key, size_bytes, sha256,
								content_type, created_at, text_content
							) VALUES (
								${current.id}, ${org.id}, ${version}, ${r2Key}, ${size}, NULL,
								${contentType}, ${updatedAt}, NULL
							)`;
					yield* refreshSearchDocument(sql, current.id, org.id);
					yield* reserveBytes(org.id, size);
					if (visibility.public) {
						yield* markScanPending(sql, org.id, current.id, version);
					}
					return {
						scan: visibility.public,
						result: {
							file: {
								...latest,
								contentType,
								version,
								sizeBytes: size,
								public: isPublicNow,
								publishPending: hold,
								htmlForcedPublic:
									latest.htmlForcedPublic || contentType === 'text/html',
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
					Effect.fail(
						new StorageError({ operation: 'commit file version', cause })
					)
				)
			);
		yield* sendIndexJob(current.id, version);
		if (committed.scan) yield* sendScanJob(current.id, version);
		return committed.result;
	});

	return {
		sql,
		blobs,
		config,
		tags,
		org,
		jobs,
		compensateStoredBlob,
		ensureHeadroom,
		ensurePublishAllowed,
		refuseQuarantined,
		reserveBytes,
		sendIndexJob,
		sendPurgeJob,
		sendScanJob,
		findDashboardFile,
		commitStoredVersion
	};
};

export type FileInternals = ReturnType<typeof createInternals>;
