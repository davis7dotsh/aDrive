import type { DashboardFile, FileDetail, FileSummary } from '@adrive/shared';
import { Context, Effect, Layer, Schema } from 'effect';
import { SqlClient } from 'effect/unstable/sql';
import { AppConfig } from '../config';
import {
	compensateBlobFailure,
	deferredBlobDeleteCommand
} from '../blob-compensation';
import { InvalidRequest, NotFound, StorageError } from '../errors';
import {
	dashboardFileColumns,
	decodeDashboardRows,
	toDashboardFile
} from '../file-rows';
import {
	cleanFileName,
	contentTypeForUpload,
	trashWindow,
	visibilityForFile
} from '../file-policy';
import { purgeCompletionCommands, type PurgeSqlCommand } from '../purge-sql';
import { fileIndexStatements } from '../search-index';
import { retryAt, safeIndexError } from '../semantic-policy';
import { validateUploadLength } from '../upload-stream';
import { Blobs } from './blobs';
import { Db } from './bindings';
import { Tags } from './tags';

const FileContentRow = Schema.Struct({
	id: Schema.String,
	display_name: Schema.String,
	content_type: Schema.String,
	version: Schema.Int,
	size_bytes: Schema.Int,
	is_public: Schema.Int,
	r2_key: Schema.String,
	created_at: Schema.String
});

const FileVersionRow = Schema.Struct({
	version: Schema.Int,
	size_bytes: Schema.Int,
	content_type: Schema.String,
	created_at: Schema.String
});

interface UploadInput {
	readonly displayName: string;
	readonly contentType: string;
	readonly public: boolean;
	readonly contentLength: string | null;
	readonly body: ReadableStream<Uint8Array> | null;
	readonly tags: ReadonlyArray<string>;
	readonly expiresAt: string | null;
}

interface VersionUploadInput {
	readonly id: string;
	readonly contentType: string;
	readonly contentLength: string | null;
	readonly body: ReadableStream<Uint8Array> | null;
}

export interface FileContent {
	readonly file: FileSummary;
	readonly r2Key: string;
}

export interface UploadResult {
	readonly file: FileSummary;
	readonly forcedPublic: boolean;
}

export interface MutationResult {
	readonly file: DashboardFile;
	readonly forcedPublic: boolean;
}

export interface FilesShape {
	readonly upload: (
		input: UploadInput
	) => Effect.Effect<UploadResult, InvalidRequest | StorageError>;
	readonly uploadVersion: (
		input: VersionUploadInput
	) => Effect.Effect<MutationResult, InvalidRequest | NotFound | StorageError>;
	readonly restoreVersion: (
		id: string,
		version: number
	) => Effect.Effect<MutationResult, InvalidRequest | NotFound | StorageError>;
	readonly list: (
		trashed: boolean
	) => Effect.Effect<ReadonlyArray<DashboardFile>, StorageError>;
	readonly detail: (
		id: string
	) => Effect.Effect<FileDetail, NotFound | StorageError>;
	readonly setVisibility: (
		id: string,
		isPublic: boolean
	) => Effect.Effect<MutationResult, InvalidRequest | NotFound | StorageError>;
	readonly trash: (
		id: string
	) => Effect.Effect<MutationResult, NotFound | StorageError>;
	readonly restore: (
		id: string
	) => Effect.Effect<MutationResult, InvalidRequest | NotFound | StorageError>;
	readonly setExpiration: (
		id: string,
		expiresAt: string | null
	) => Effect.Effect<MutationResult, InvalidRequest | NotFound | StorageError>;
	readonly rename: (
		id: string,
		displayName: string
	) => Effect.Effect<MutationResult, InvalidRequest | NotFound | StorageError>;
	readonly schedulePurgeNow: (
		id: string
	) => Effect.Effect<MutationResult, InvalidRequest | NotFound | StorageError>;
	readonly scheduleAllPurgesNow: Effect.Effect<number, StorageError>;
	readonly recordDownload: (id: string) => Effect.Effect<void, StorageError>;
	readonly sweepPurges: (limit: number) => Effect.Effect<number, StorageError>;
	readonly findContent: (
		id: string,
		version?: number,
		includeUnavailable?: boolean
	) => Effect.Effect<FileContent, InvalidRequest | NotFound | StorageError>;
}

export class Files extends Context.Service<Files, FilesShape>()('app/Files') {}

const decodeVersionRows = (rows: unknown) => {
	const decoded = Schema.decodeUnknownOption(Schema.Array(FileVersionRow))(
		rows
	);
	return decoded._tag === 'Some' ? decoded.value : [];
};

const decodeContentRows = (rows: unknown) => {
	const decoded = Schema.decodeUnknownOption(Schema.Array(FileContentRow))(
		rows
	);
	return decoded._tag === 'Some' ? decoded.value : [];
};

const toVersion = (row: typeof FileVersionRow.Type) => ({
	version: row.version,
	sizeBytes: row.size_bytes,
	contentType: row.content_type,
	createdAt: row.created_at
});

const makeFiles = Effect.gen(function* () {
	const db = yield* Db;
	const blobs = yield* Blobs;
	const sql = (yield* SqlClient.SqlClient).withoutTransforms();
	const config = yield* AppConfig;
	const tags = yield* Tags;
	const preparePurgeCommand = (command: PurgeSqlCommand) =>
		db.prepare(command.sql).bind(...command.bindings);
	const compensateStoredBlob = (
		failure: StorageError,
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

	return Files.of({
		upload: Effect.fn('Files.upload')(function* (input) {
			const size = yield* Effect.try({
				try: () =>
					validateUploadLength(input.contentLength, config.maxUploadBytes),
				catch: (cause) =>
					cause instanceof InvalidRequest
						? cause
						: new InvalidRequest({
								status: 400,
								message: 'Upload length is invalid'
							})
			});
			const displayName = yield* Effect.try({
				try: () => cleanFileName(input.displayName),
				catch: (cause) =>
					cause instanceof InvalidRequest
						? cause
						: new InvalidRequest({
								status: 400,
								message: 'File name is invalid'
							})
			});
			const contentType = contentTypeForUpload(displayName, input.contentType);
			const visibility = visibilityForFile(
				displayName,
				contentType,
				input.public
			);
			const id = crypto.randomUUID();
			const resolvedTags = yield* tags.resolveNames(input.tags);
			const r2Key = `v/${id}/${crypto.randomUUID()}`;
			const createdAt = new Date().toISOString();
			const stored = yield* blobs.put(r2Key, input.body, size, contentType);
			const statements = [
				db
					.prepare(
						`INSERT INTO files (
							id, display_name, content_type, kind, current_version, size_bytes,
							public, is_site, created_at, updated_at, expires_at, index_state
						) VALUES (?, ?, ?, 'file', 1, ?, ?, 0, ?, ?, ?, 'pending')`
					)
					.bind(
						id,
						displayName,
						contentType,
						stored.size,
						visibility.public ? 1 : 0,
						createdAt,
						createdAt,
						input.expiresAt
					),
				db
					.prepare(
						`INSERT INTO file_versions (
							file_id, version, r2_key, size_bytes, sha256, content_type, created_at,
							text_content
						) VALUES (?, 1, ?, ?, NULL, ?, ?, ?)`
					)
					.bind(id, r2Key, stored.size, contentType, createdAt, null),
				...resolvedTags.map((tag) =>
					db
						.prepare('INSERT INTO file_tags (file_id, tag_id) VALUES (?, ?)')
						.bind(id, tag.id)
				),
				...fileIndexStatements(db, id)
			];

			const commit = Effect.tryPromise({
				try: () => db.batch(statements),
				catch: (cause) =>
					new StorageError({ operation: 'commit file metadata', cause })
			});
			yield* commit.pipe(
				Effect.catch((failure) =>
					compensateStoredBlob(failure, id, 1, r2Key, 'upload')
				)
			);

			return {
				file: {
					id,
					displayName,
					contentType,
					kind: 'file',
					version: 1,
					sizeBytes: stored.size,
					public: visibility.public,
					createdAt,
					expiresAt: input.expiresAt,
					downloadCount: 0,
					lastDownloadAt: null,
					indexState: 'pending',
					indexedVersion: null,
					indexAttempts: 0,
					indexError: null
				},
				forcedPublic: visibility.forcedPublic
			};
		}),
		uploadVersion: Effect.fn('Files.uploadVersion')(function* (input) {
			const current = yield* findDashboardFile(input.id);
			if (current.deletedAt !== null)
				return yield* new NotFound({ id: input.id });
			if (current.kind === 'site') {
				return yield* new InvalidRequest({
					status: 400,
					message: 'Republish sites with `adrive site put`'
				});
			}
			const size = yield* Effect.try({
				try: () =>
					validateUploadLength(input.contentLength, config.maxUploadBytes),
				catch: (cause) =>
					cause instanceof InvalidRequest
						? cause
						: new InvalidRequest({
								status: 400,
								message: 'Upload length is invalid'
							})
			});
			const contentType = contentTypeForUpload(
				current.displayName,
				input.contentType
			);
			const r2Key = `v/${current.id}/${crypto.randomUUID()}`;
			const stored = yield* blobs.put(r2Key, input.body, size, contentType);
			const commit = commitStoredVersion(
				current,
				r2Key,
				stored.size,
				contentType
			);
			return yield* commit.pipe(
				Effect.catch((failure) =>
					compensateStoredBlob(
						failure,
						current.id,
						current.version + 1,
						r2Key,
						'version upload'
					)
				)
			);
		}),
		restoreVersion: Effect.fn('Files.restoreVersion')(function* (id, version) {
			if (!Number.isSafeInteger(version) || version < 1) {
				return yield* new InvalidRequest({
					status: 400,
					message: 'Version is invalid'
				});
			}
			const current = yield* findDashboardFile(id);
			if (current.deletedAt !== null) return yield* new NotFound({ id });
			if (current.kind === 'site') {
				return yield* new InvalidRequest({
					status: 400,
					message: 'Republish sites with `adrive site put`'
				});
			}
			if (current.version === version) {
				return yield* new InvalidRequest({
					status: 409,
					message: 'That version is already current'
				});
			}
			const rows = yield* sql`
				SELECT
					f.id, f.display_name, v.content_type, v.version, v.size_bytes,
					f.public AS is_public, v.r2_key, v.created_at
				FROM files f
				JOIN file_versions v ON v.file_id = f.id
				WHERE f.id = ${id} AND v.version = ${version}
					AND f.deleted_at IS NULL AND f.is_site = 0
				LIMIT 1
			`.pipe(
				Effect.mapError(
					(cause) =>
						new StorageError({ operation: 'find version to restore', cause })
				)
			);
			const source = decodeContentRows(rows)[0];
			if (!source) return yield* new NotFound({ id });
			const sourceObject = yield* blobs.get(source.r2_key);
			const r2Key = `v/${current.id}/${crypto.randomUUID()}`;
			const stored = yield* blobs.put(
				r2Key,
				sourceObject.body,
				source.size_bytes,
				source.content_type
			);
			return yield* commitStoredVersion(
				current,
				r2Key,
				stored.size,
				source.content_type
			).pipe(
				Effect.catch((failure) =>
					compensateStoredBlob(
						failure,
						current.id,
						current.version + 1,
						r2Key,
						'version restore'
					)
				)
			);
		}),
		list: Effect.fn('Files.list')(function* (trashed) {
			const now = new Date().toISOString();
			const rows = yield* sql
				.unsafe(
					`SELECT ${dashboardFileColumns}
					FROM files f
					WHERE f.deleted_at IS ${trashed ? 'NOT NULL' : 'NULL'}
						${trashed ? 'AND (f.purge_at IS NULL OR f.purge_at > ?)' : 'AND (f.expires_at IS NULL OR f.expires_at > ?)'}
					ORDER BY ${trashed ? 'f.deleted_at' : 'f.updated_at'} DESC, f.id
					LIMIT 200`,
					[now]
				)
				.pipe(
					Effect.mapError(
						(cause) =>
							new StorageError({
								operation: trashed ? 'list trashed files' : 'list active files',
								cause
							})
					)
				);
			return decodeDashboardRows(rows).map(toDashboardFile);
		}),
		detail: Effect.fn('Files.detail')(function* (id) {
			const file = yield* findDashboardFile(id);
			const rows = yield* sql`
				SELECT version, size_bytes, content_type, created_at
				FROM file_versions
				WHERE file_id = ${id}
				ORDER BY version DESC
			`.pipe(
				Effect.mapError(
					(cause) =>
						new StorageError({ operation: 'list file versions', cause })
				)
			);
			return {
				file,
				versions: decodeVersionRows(rows).map(toVersion)
			};
		}),
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
		}),
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

				const keys = yield* Effect.tryPromise({
					try: async () => {
						const [versions, assets] = await Promise.all([
							db
								.prepare(
									'SELECT r2_key FROM file_versions WHERE file_id = ? AND r2_key NOT LIKE ?'
								)
								.bind(row.id, 'site-version/%')
								.all<{ r2_key: string }>(),
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
						return [
							...versions.results.map((item) => item.r2_key),
							...assets.results.map((item) => item.r2_key)
						];
					},
					catch: (cause) =>
						new StorageError({ operation: 'list file purge keys', cause })
				});

				const deleted = yield* blobs.deleteMany(keys).pipe(
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
			}
			return due.length;
		}),
		findContent: Effect.fn('Files.findContent')(function* (
			id,
			version,
			includeUnavailable = false
		) {
			if (
				version !== undefined &&
				(!Number.isSafeInteger(version) || version < 1)
			) {
				return yield* new InvalidRequest({
					status: 400,
					message: 'Version is invalid'
				});
			}
			const rows =
				version === undefined
					? yield* sql`
							SELECT
								f.id, f.display_name, v.content_type, v.version, v.size_bytes,
								f.public AS is_public, v.r2_key, v.created_at
							FROM files f
							JOIN file_versions v
								ON v.file_id = f.id AND v.version = f.current_version
							WHERE f.id = ${id}
								AND (
									${includeUnavailable ? 1 : 0} = 1
									OR (
										f.deleted_at IS NULL
										AND (
											f.expires_at IS NULL
											OR f.expires_at > ${new Date().toISOString()}
										)
									)
								)
								AND f.is_site = 0
							LIMIT 1
						`.pipe(
							Effect.mapError(
								(cause) => new StorageError({ operation: 'find file', cause })
							)
						)
					: yield* sql`
							SELECT
								f.id, f.display_name, v.content_type, v.version, v.size_bytes,
								f.public AS is_public, v.r2_key, v.created_at
							FROM files f
							JOIN file_versions v ON v.file_id = f.id
							WHERE f.id = ${id} AND v.version = ${version}
								AND (
									${includeUnavailable ? 1 : 0} = 1
									OR (
										f.deleted_at IS NULL
										AND (
											f.expires_at IS NULL
											OR f.expires_at > ${new Date().toISOString()}
										)
									)
								)
								AND f.is_site = 0
							LIMIT 1
						`.pipe(
							Effect.mapError(
								(cause) =>
									new StorageError({ operation: 'find file version', cause })
							)
						);
			const row = decodeContentRows(rows)[0];
			if (!row) return yield* new NotFound({ id });
			return {
				file: {
					id: row.id,
					displayName: row.display_name,
					contentType: row.content_type,
					kind: 'file',
					version: row.version,
					sizeBytes: row.size_bytes,
					public: row.is_public === 1,
					createdAt: row.created_at,
					expiresAt: null,
					downloadCount: 0,
					lastDownloadAt: null,
					indexState: 'disabled',
					indexedVersion: null,
					indexAttempts: 0,
					indexError: null
				},
				r2Key: row.r2_key
			};
		})
	});
});

export const FilesLive = Layer.effect(Files, makeFiles);
