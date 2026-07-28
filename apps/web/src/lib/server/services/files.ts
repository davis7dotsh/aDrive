import type { FileSummary } from '@adrive/shared';
import { Context, Effect, Layer, Schema } from 'effect';
import { SqlClient } from 'effect/unstable/sql';
import { AppConfig } from '../config';
import { InvalidRequest, NotFound, StorageError } from '../errors';
import { validateUploadLength } from '../upload-stream';
import { Blobs } from './blobs';
import { Db } from './bindings';

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

interface UploadInput {
	readonly displayName: string;
	readonly contentType: string;
	readonly public: boolean;
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

export interface FilesShape {
	readonly upload: (
		input: UploadInput
	) => Effect.Effect<UploadResult, InvalidRequest | StorageError>;
	readonly findContent: (
		id: string,
		version?: number
	) => Effect.Effect<FileContent, InvalidRequest | NotFound | StorageError>;
}

export class Files extends Context.Service<Files, FilesShape>()('app/Files') {}

const cleanName = (value: string) => {
	const name = value.split(/[\\/]/).at(-1)?.trim() ?? '';
	if (!name || name.length > 255 || /[\u0000-\u001f\u007f]/.test(name)) {
		throw new InvalidRequest({ status: 400, message: 'File name is invalid' });
	}
	return name;
};

const cleanContentType = (value: string) => {
	const contentType = value.split(';', 1)[0]?.trim().toLowerCase() ?? '';
	return /^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/.test(contentType)
		? contentType
		: 'application/octet-stream';
};

const isHtml = (name: string, contentType: string) =>
	contentType === 'text/html' || /\.html?$/i.test(name);

const decodeContentRow = (rows: unknown) => {
	const decoded = Schema.decodeUnknownOption(Schema.Array(FileContentRow))(
		rows
	);
	return decoded._tag === 'Some' ? decoded.value[0] : undefined;
};

const makeFiles = Effect.gen(function* () {
	const db = yield* Db;
	const blobs = yield* Blobs;
	const sql = yield* SqlClient.SqlClient;
	const config = yield* AppConfig;

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
				try: () => cleanName(input.displayName),
				catch: (cause) =>
					cause instanceof InvalidRequest
						? cause
						: new InvalidRequest({
								status: 400,
								message: 'File name is invalid'
							})
			});
			const suppliedContentType = cleanContentType(input.contentType);
			const contentType = /\.html?$/i.test(displayName)
				? 'text/html'
				: suppliedContentType;
			const forcedPublic = isHtml(displayName, contentType) && !input.public;
			const isPublic = input.public || forcedPublic;
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
						isPublic ? 1 : 0,
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
					public: isPublic,
					createdAt
				},
				forcedPublic
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
			const row = decodeContentRow(rows);
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
