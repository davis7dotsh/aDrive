import type { DashboardFile, FileDetail, FileSummary } from '@adrive/shared';
import { Context, Effect, Layer, Schema } from 'effect';
import { SqlClient } from 'effect/unstable/sql';
import { AppConfig } from '../config';
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
import { fileIndexStatements } from '../search-index';
import { isSearchableText, searchTextLimit } from '../search-text';
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
	) => Effect.Effect<MutationResult, NotFound | StorageError>;
	readonly setExpiration: (
		id: string,
		expiresAt: string | null
	) => Effect.Effect<MutationResult, InvalidRequest | NotFound | StorageError>;
	readonly recordDownload: (id: string) => Effect.Effect<void, StorageError>;
	readonly findContent: (
		id: string,
		version?: number
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

	const readStoredSearchText = Effect.fn('Files.readStoredSearchText')(
		function* (name: string, contentType: string, r2Key: string) {
			if (!isSearchableText(name, contentType)) return null;
			return yield* blobs.readTextPrefix(r2Key, searchTextLimit).pipe(
				Effect.catch((failure) =>
					blobs.delete(r2Key).pipe(
						Effect.catchCause((cleanupCause) =>
							Effect.sync(() => {
								console.error(
									JSON.stringify({
										message: 'search text compensation failed',
										r2Key,
										cause: String(cleanupCause)
									})
								);
							})
						),
						Effect.andThen(Effect.fail(failure))
					)
				)
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
		contentType: string,
		textContent: string | null
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
							public = ?, updated_at = ?
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
					textContent,
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
				updatedAt
			},
			forcedPublic: visibility.forcedPublic
		};
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
			const textContent = yield* readStoredSearchText(
				displayName,
				contentType,
				r2Key
			);

			const statements = [
				db
					.prepare(
						`INSERT INTO files (
							id, display_name, content_type, kind, current_version, size_bytes,
							public, is_site, created_at, updated_at, expires_at, index_state
						) VALUES (?, ?, ?, 'file', 1, ?, ?, 0, ?, ?, ?, 'disabled')`
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
					.bind(id, r2Key, stored.size, contentType, createdAt, textContent),
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
					blobs.delete(r2Key).pipe(
						Effect.catchCause((cleanupCause) =>
							Effect.sync(() => {
								console.error(
									JSON.stringify({
										message: 'upload compensation failed',
										r2Key,
										cause: String(cleanupCause)
									})
								);
							})
						),
						Effect.andThen(Effect.fail(failure))
					)
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
					lastDownloadAt: null
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
			const textContent = yield* readStoredSearchText(
				current.displayName,
				contentType,
				r2Key
			);
			const commit = commitStoredVersion(
				current,
				r2Key,
				stored.size,
				contentType,
				textContent
			);
			return yield* commit.pipe(
				Effect.catch((failure) =>
					blobs.delete(r2Key).pipe(
						Effect.catchCause((cleanupCause) =>
							Effect.sync(() => {
								console.error(
									JSON.stringify({
										message: 'version upload compensation failed',
										r2Key,
										cause: String(cleanupCause)
									})
								);
							})
						),
						Effect.andThen(Effect.fail(failure))
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
						${trashed ? '' : 'AND (f.expires_at IS NULL OR f.expires_at > ?)'}
					ORDER BY ${trashed ? 'f.deleted_at' : 'f.updated_at'} DESC, f.id
					LIMIT 200`,
					trashed ? [] : [now]
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
			yield* sql`
				UPDATE files
				SET deleted_at = ${deletedAt}, purge_at = ${purgeAt}, purge_state = 'none',
					updated_at = ${deletedAt}
				WHERE id = ${id}
			`.pipe(
				Effect.mapError(
					(cause) => new StorageError({ operation: 'trash file', cause })
				)
			);
			return {
				file: { ...current, deletedAt, updatedAt: deletedAt },
				forcedPublic: false
			};
		}),
		restore: Effect.fn('Files.restore')(function* (id) {
			const current = yield* findDashboardFile(id);
			const updatedAt = new Date().toISOString();
			yield* sql`
				UPDATE files
				SET deleted_at = NULL, purge_at = NULL, purge_state = 'none',
					updated_at = ${updatedAt}
				WHERE id = ${id}
			`.pipe(
				Effect.mapError(
					(cause) => new StorageError({ operation: 'restore file', cause })
				)
			);
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
		findContent: Effect.fn('Files.findContent')(function* (id, version) {
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
							WHERE f.id = ${id} AND f.deleted_at IS NULL
								AND (f.expires_at IS NULL OR f.expires_at > ${new Date().toISOString()})
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
							WHERE f.id = ${id} AND v.version = ${version} AND f.deleted_at IS NULL
								AND (f.expires_at IS NULL OR f.expires_at > ${new Date().toISOString()})
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
					lastDownloadAt: null
				},
				r2Key: row.r2_key
			};
		})
	});
});

export const FilesLive = Layer.effect(Files, makeFiles);
