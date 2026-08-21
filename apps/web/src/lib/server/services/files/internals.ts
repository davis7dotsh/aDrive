import type { DashboardFile } from '@adrive/shared';
import { Effect } from 'effect';
import { SqlClient } from 'effect/unstable/sql';
import {
	compensateBlobFailure,
	deferredBlobDeleteCommand
} from '../../blob-compensation';
import { NotFound, StorageError } from '../../errors';
import {
	dashboardFileColumns,
	decodeDashboardRows,
	toDashboardFile
} from '../../file-rows';
import { visibilityForFile } from '../../file-policy';
import type { PurgeSqlCommand } from '../../purge-sql';
import { fileIndexStatements } from '../../search-index';
import { ensureStorageQuota } from '../../storage-quota';
import type { AppConfig } from '../../config';
import type { Blobs } from '../blobs';
import type { Db } from '../bindings';
import type { Tags } from '../tags';
import type { MutationResult } from './types';

export interface CoreDeps {
	readonly db: Db['Service'];
	readonly blobs: Blobs['Service'];
	readonly sql: (typeof SqlClient.SqlClient)['Service'];
	readonly config: AppConfig['Service'];
	readonly tags: Tags['Service'];
}

export const createInternals = (deps: CoreDeps) => {
	const { db, blobs, sql, config, tags } = deps;
	const preparePurgeCommand = (command: PurgeSqlCommand) =>
		db.prepare(command.sql).bind(...command.bindings);
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
			(deleteCause) => {
				const command = deferredBlobDeleteCommand(
					r2Key,
					fileId,
					version,
					new Date().toISOString(),
					String(deleteCause)
				);
				return Effect.tryPromise({
					try: () =>
						db
							.prepare(command.sql)
							.bind(...command.bindings)
							.run(),
					catch: (cause) =>
						new StorageError({
							operation: 'queue orphaned file blob',
							cause
						})
				});
			},
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

	// One aggregate query per upload; at personal scale this stays cheap
	// and cannot drift the way a maintained counter can.
	const checkStorageQuota = (incomingBytes: number) =>
		ensureStorageQuota(db, config.maxTotalBytes, incomingBytes);

	const findDashboardFile = Effect.fn('Files.findDashboardFile')(function* (
		id: string
	) {
		const rows = yield* sql
			.unsafe(
				`SELECT ${dashboardFileColumns}
				FROM files f
				WHERE f.id = ?
				LIMIT 1`,
				[id]
			)
			.pipe(
				Effect.mapError(
					(cause) =>
						new StorageError({ operation: 'find dashboard file', cause })
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
		const statements = [
			db
				.prepare(
					`UPDATE files
						SET current_version = ?, size_bytes = ?, content_type = ?,
							public = ?, updated_at = ?, index_state = 'pending',
							index_cursor = 0, index_attempts = 0, index_error = NULL,
							index_next_run_at = NULL, index_lease_token = NULL
						WHERE id = ? AND current_version = ? AND deleted_at IS NULL`
				)
				.bind(
					version,
					size,
					contentType,
					visibility.public ? 1 : 0,
					updatedAt,
					current.id,
					current.version
				),
			db
				.prepare(
					`INSERT INTO file_versions (
						file_id, version, r2_key, size_bytes, sha256, content_type, created_at,
						text_content
					)
					SELECT ?, ?, ?, ?, NULL, ?, ?, ?
					WHERE EXISTS (
						SELECT 1 FROM files
						WHERE id = ? AND current_version = ? AND deleted_at IS NULL
					)`
				)
				.bind(
					current.id,
					version,
					r2Key,
					size,
					contentType,
					updatedAt,
					null,
					current.id,
					version
				),
			...fileIndexStatements(db, current.id)
		];
		yield* Effect.tryPromise({
			try: async () => {
				const results = await db.batch(statements);
				if (results[0]?.meta.changes !== 1 || results[1]?.meta.changes !== 1) {
					throw new Error('File changed while the version was uploading');
				}
			},
			catch: (cause) =>
				new StorageError({ operation: 'commit file version', cause })
		});
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
		db,
		blobs,
		sql,
		config,
		tags,
		preparePurgeCommand,
		compensateStoredBlob,
		checkStorageQuota,
		findDashboardFile,
		commitStoredVersion
	};
};

export type FileInternals = ReturnType<typeof createInternals>;
