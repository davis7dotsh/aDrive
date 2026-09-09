import type { DashboardFile } from '@adrive/shared';
import type { PgClient } from '@effect/sql-pg';
import { Effect } from 'effect';
import {
	compensateBlobFailure,
	queueDeferredBlobDelete
} from '../../blob-compensation';
import { NotFound, StorageError } from '../../errors';
import {
	dashboardFileColumns,
	decodeDashboardRows,
	toDashboardFile
} from '../../file-rows';
import { visibilityForFile } from '../../file-policy';
import { refreshSearchDocument } from '../../search-index';
import { ensureStorageHeadroom, reserveWithinPlan } from '../../storage-quota';
import type { AppConfig } from '../../config';
import type { Blobs } from '../blobs';
import type { Tags } from '../tags';
import type { CurrentOrg } from '../current-org';
import type { MutationResult } from './types';

export interface CoreDeps {
	readonly sql: PgClient.PgClient;
	readonly blobs: Blobs['Service'];
	readonly config: AppConfig['Service'];
	readonly tags: Tags['Service'];
	readonly org: CurrentOrg['Service'];
}

export const createInternals = (deps: CoreDeps) => {
	const { sql, blobs, config, tags, org } = deps;
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

	// Cheap read before a body streams; the reservation inside the commit
	// transaction is what actually holds the bytes.
	const ensureHeadroom = (incomingBytes: number) =>
		ensureStorageHeadroom(sql, org.id, incomingBytes);
	const reserveBytes = (orgId: string, delta: number) =>
		reserveWithinPlan(sql, orgId, delta);

	const findDashboardFile = Effect.fn('Files.findDashboardFile')(function* (
		id: string
	) {
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
		return toDashboardFile(row);
	});

	const commitStoredVersion = Effect.fn('Files.commitStoredVersion')(function* (
		current: DashboardFile,
		r2Key: string,
		size: number,
		contentType: string
	) {
		const version = current.version + 1;
		const updatedAt = new Date().toISOString();
		const visibility = visibilityForFile(
			current.displayName,
			current.htmlForcedPublic ? 'text/html' : contentType,
			current.public
		);
		// Optimistic concurrency on current_version: a concurrent upload
		// that committed first makes this update match nothing.
		yield* sql
			.withTransaction(
				Effect.gen(function* () {
					const updated = yield* sql<{ id: string }>`
						UPDATE files
						SET current_version = ${version}, size_bytes = ${size},
							content_type = ${contentType}, public = ${visibility.public},
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

				})
			)
			.pipe(
				Effect.catchTag('SqlError', (cause) =>
					Effect.fail(
						new StorageError({ operation: 'commit file version', cause })
					)
				)
			);
		return {
			file: {
				...current,
				contentType,
				version,
				sizeBytes: size,
				public: visibility.public,
				htmlForcedPublic:
					current.htmlForcedPublic || contentType === 'text/html',
				updatedAt,
				indexState: 'pending',
				indexAttempts: 0,
				indexError: null
			},
			forcedPublic: visibility.forcedPublic
		} satisfies MutationResult;
	});

	return {
		sql,
		blobs,
		config,
		tags,
		org,
		compensateStoredBlob,
		ensureHeadroom,
		reserveBytes,
		findDashboardFile,
		commitStoredVersion
	};
};

export type FileInternals = ReturnType<typeof createInternals>;
