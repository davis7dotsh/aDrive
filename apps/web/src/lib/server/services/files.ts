import type { DashboardFile, FileDetail, FileSummary } from '@adrive/shared';
import { Context, Effect, Layer, Schema } from 'effect';
import { SqlClient } from 'effect/unstable/sql';
import { AppConfig } from '../config';
import { InvalidRequest, NotFound, StorageError } from '../errors';
import {
	cleanFileName,
	contentTypeForUpload,
	trashWindow,
	visibilityForFile
} from '../file-policy';
import { validateUploadLength } from '../upload-stream';
import { Blobs } from './blobs';
import { Db } from './bindings';

const DashboardFileRow = Schema.Struct({
	id: Schema.String,
	display_name: Schema.String,
	content_type: Schema.String,
	current_version: Schema.Int,
	size_bytes: Schema.Int,
	is_public: Schema.Int,
	has_html: Schema.Int,
	created_at: Schema.String,
	updated_at: Schema.String,
	deleted_at: Schema.NullOr(Schema.String)
});

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
	) => Effect.Effect<MutationResult, NotFound | StorageError>;
	readonly trash: (
		id: string
	) => Effect.Effect<MutationResult, NotFound | StorageError>;
	readonly restore: (
		id: string
	) => Effect.Effect<MutationResult, NotFound | StorageError>;
	readonly findContent: (
		id: string,
		version?: number
	) => Effect.Effect<FileContent, InvalidRequest | NotFound | StorageError>;
}

export class Files extends Context.Service<Files, FilesShape>()('app/Files') {}

const decodeDashboardRows = (rows: unknown) => {
	const decoded = Schema.decodeUnknownOption(Schema.Array(DashboardFileRow))(
		rows
	);
	return decoded._tag === 'Some' ? decoded.value : [];
};

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

const toDashboardFile = (row: typeof DashboardFileRow.Type) => ({
	id: row.id,
	displayName: row.display_name,
	contentType: row.content_type,
	version: row.current_version,
	sizeBytes: row.size_bytes,
	public: row.is_public === 1,
	htmlForcedPublic: row.has_html === 1,
	createdAt: row.created_at,
	updatedAt: row.updated_at,
	deletedAt: row.deleted_at
});

const toVersion = (row: typeof FileVersionRow.Type) => ({
	version: row.version,
	sizeBytes: row.size_bytes,
	contentType: row.content_type,
	createdAt: row.created_at
});

const makeFiles = Effect.gen(function* () {
	const db = yield* Db;
	const blobs = yield* Blobs;
	const sql = yield* SqlClient.SqlClient;
	const config = yield* AppConfig;

	const findDashboardFile = Effect.fn('Files.findDashboardFile')(function* (
		id: string
	) {
		const rows = yield* sql`
				SELECT
					id, display_name, content_type, current_version, size_bytes,
					public AS is_public,
					EXISTS (
						SELECT 1 FROM file_versions v
						WHERE v.file_id = files.id AND v.content_type = 'text/html'
					) AS has_html,
					created_at, updated_at, deleted_at
				FROM files
				WHERE id = ${id}
				LIMIT 1
			`.pipe(
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
						file_id, version, r2_key, size_bytes, sha256, content_type, created_at
					)
					SELECT ?, ?, ?, ?, NULL, ?, ?
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
					current.id,
					version
				)
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
			const r2Key = `v/${id}/${crypto.randomUUID()}`;
			const createdAt = new Date().toISOString();
			const stored = yield* blobs.put(r2Key, input.body, size, contentType);

			const statements = [
				db
					.prepare(
						`INSERT INTO files (
							id, display_name, content_type, kind, current_version, size_bytes,
							public, is_site, created_at, updated_at, index_state
						) VALUES (?, ?, ?, 'file', 1, ?, ?, 0, ?, ?, 'disabled')`
					)
					.bind(
						id,
						displayName,
						contentType,
						stored.size,
						visibility.public ? 1 : 0,
						createdAt,
						createdAt
					),
				db
					.prepare(
						`INSERT INTO file_versions (
							file_id, version, r2_key, size_bytes, sha256, content_type, created_at
						) VALUES (?, 1, ?, ?, NULL, ?, ?)`
					)
					.bind(id, r2Key, stored.size, contentType, createdAt)
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
					version: 1,
					sizeBytes: stored.size,
					public: visibility.public,
					createdAt
				},
				forcedPublic: visibility.forcedPublic
			};
		}),
		uploadVersion: Effect.fn('Files.uploadVersion')(function* (input) {
			const current = yield* findDashboardFile(input.id);
			if (current.deletedAt !== null)
				return yield* new NotFound({ id: input.id });
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
			const rows = trashed
				? yield* sql`
						SELECT
							id, display_name, content_type, current_version, size_bytes,
							public AS is_public,
							EXISTS (
								SELECT 1 FROM file_versions v
								WHERE v.file_id = files.id AND v.content_type = 'text/html'
							) AS has_html,
							created_at, updated_at, deleted_at
						FROM files
						WHERE deleted_at IS NOT NULL
						ORDER BY deleted_at DESC, id
						LIMIT 200
					`.pipe(
						Effect.mapError(
							(cause) =>
								new StorageError({ operation: 'list trashed files', cause })
						)
					)
				: yield* sql`
						SELECT
							id, display_name, content_type, current_version, size_bytes,
							public AS is_public,
							EXISTS (
								SELECT 1 FROM file_versions v
								WHERE v.file_id = files.id AND v.content_type = 'text/html'
							) AS has_html,
							created_at, updated_at, deleted_at
						FROM files
						WHERE deleted_at IS NULL
						ORDER BY updated_at DESC, id
						LIMIT 200
					`.pipe(
						Effect.mapError(
							(cause) =>
								new StorageError({ operation: 'list active files', cause })
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
					version: row.version,
					sizeBytes: row.size_bytes,
					public: row.is_public === 1,
					createdAt: row.created_at
				},
				r2Key: row.r2_key
			};
		})
	});
});

export const FilesLive = Layer.effect(Files, makeFiles);
