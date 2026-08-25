import { type FileSummary, type UploadSessionCreate } from '@adrive/shared';
import { Context, Effect, Layer, Schema } from 'effect';
import { validateExpiration } from '../auth-policy';
import { AppConfig } from '../config';
import { InvalidRequest, NotFound, StorageError, validate } from '../errors';
import {
	cleanFileName,
	contentTypeForUpload,
	visibilityForFile
} from '../file-policy';
import { fileIndexStatements } from '../search-index';
import { ensureStorageQuota } from '../storage-quota';
import {
	choosePartSize,
	expectedPartSize,
	partCountFor,
	UPLOAD_SESSION_TTL_MS,
	validatePartLength,
	validatePartNumber,
	validateSessionSize
} from '../upload-session-policy';
import { Blobs } from './blobs';
import { Db } from './bindings';
import { forgetTagListCache, Tags } from './tags';

const MAX_UPLOAD_TAGS = 50;

const SessionRow = Schema.Struct({
	id: Schema.String,
	file_id: Schema.String,
	r2_key: Schema.String,
	display_name: Schema.String,
	content_type: Schema.String,
	public: Schema.Int,
	expected_size_bytes: Schema.Int,
	part_size_bytes: Schema.Int,
	r2_upload_id: Schema.String,
	status: Schema.String,
	expires_at: Schema.String,
	tags: Schema.String,
	file_expires_at: Schema.NullOr(Schema.String)
});

const PartRow = Schema.Struct({
	part_number: Schema.Int,
	etag: Schema.String,
	size_bytes: Schema.Int
});

const decodeRows = <A, I>(schema: Schema.Codec<A, I, never>, rows: unknown) => {
	const decoded = Schema.decodeUnknownOption(Schema.Array(schema))(rows);
	return decoded._tag === 'Some' ? decoded.value : [];
};

export interface UploadSessionInfo {
	readonly sessionId: string;
	readonly fileId: string;
	readonly partSize: number;
	readonly partCount: number;
	readonly expiresAt: string;
}

export interface UploadPartInfo {
	readonly sessionId: string;
	readonly partNumber: number;
	readonly contentLength: string | null;
	readonly body: ReadableStream<Uint8Array> | null;
}

export interface UploadResult {
	readonly file: FileSummary;
	readonly forcedPublic: boolean;
}

export interface UploadsShape {
	readonly create: (
		input: UploadSessionCreate
	) => Effect.Effect<UploadSessionInfo, InvalidRequest | StorageError>;
	readonly uploadPart: (input: UploadPartInfo) => Effect.Effect<
		{
			readonly partNumber: number;
			readonly etag: string;
			readonly sizeBytes: number;
		},
		InvalidRequest | NotFound | StorageError
	>;
	readonly complete: (
		sessionId: string
	) => Effect.Effect<UploadResult, InvalidRequest | NotFound | StorageError>;
	readonly abort: (
		sessionId: string
	) => Effect.Effect<void, NotFound | StorageError>;
	readonly sweep: (limit: number) => Effect.Effect<number, StorageError>;
}

export class Uploads extends Context.Service<Uploads, UploadsShape>()(
	'app/Uploads'
) {}

const makeUploads = Effect.gen(function* () {
	const db = yield* Db;
	const blobs = yield* Blobs;
	const config = yield* AppConfig;
	const tags = yield* Tags;

	const loadSession = Effect.fn('Uploads.loadSession')(function* (
		sessionId: string
	) {
		const rows = yield* Effect.tryPromise({
			try: async () => {
				const result = await db
					.prepare(
						`SELECT id, file_id, r2_key, display_name, content_type, public,
							expected_size_bytes, part_size_bytes, r2_upload_id, status,
							expires_at, tags, file_expires_at
						FROM upload_sessions WHERE id = ? LIMIT 1`
					)
					.bind(sessionId)
					.all();
				if (!result.success) throw new Error(result.error ?? 'load session');
				return result.results;
			},
			catch: (cause) =>
				new StorageError({ operation: 'load upload session', cause })
		});
		const row = decodeRows(SessionRow, rows)[0];
		if (!row) return yield* new NotFound({ id: sessionId });
		return row;
	});

	const assertOpen = (row: typeof SessionRow.Type) =>
		row.status === 'open' && new Date(row.expires_at).getTime() > Date.now()
			? Effect.void
			: Effect.fail(
					new InvalidRequest({
						status: 409,
						message: 'Upload session is no longer open'
					})
				);

	return Uploads.of({
		create: Effect.fn('Uploads.create')(function* (input) {
			const size = yield* validate(() =>
				(() => {
					validateSessionSize(input.sizeBytes, config.maxStagedUploadBytes);
					return input.sizeBytes;
				})()
			);
			const displayName = yield* validate(() => cleanFileName(input.name));
			const contentType = contentTypeForUpload(
				displayName,
				input.contentType ?? 'application/octet-stream'
			);
			const tagNames = (input.tags ?? []).slice(0, MAX_UPLOAD_TAGS);
			const expiresAt = yield* validate(() =>
				validateExpiration(input.expiresAt ?? null)
			);
			yield* ensureStorageQuota(db, config.maxTotalBytes, size);

			const fileId = crypto.randomUUID();
			const r2Key = `v/${fileId}/${crypto.randomUUID()}`;
			const partSize = choosePartSize(size);
			const partCount = partCountFor(size, partSize);
			const requestedPublic = input.public ?? true;
			const created = new Date();
			const sessionExpiresAt = new Date(
				created.getTime() + UPLOAD_SESSION_TTL_MS
			).toISOString();
			const sessionId = crypto.randomUUID();

			const { uploadId } = yield* blobs.createMultipart(r2Key, contentType);
			yield* Effect.tryPromise({
				try: () =>
					db
						.prepare(
							`INSERT INTO upload_sessions (
								id, file_id, r2_key, display_name, content_type, public,
								expected_size_bytes, part_size_bytes, r2_upload_id, status,
								created_at, expires_at, tags, file_expires_at
							) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'open', ?, ?, ?, ?)`
						)
						.bind(
							sessionId,
							fileId,
							r2Key,
							displayName,
							contentType,
							requestedPublic ? 1 : 0,
							size,
							partSize,
							uploadId,
							created.toISOString(),
							sessionExpiresAt,
							JSON.stringify(tagNames),
							expiresAt
						)
						.run(),
				catch: (cause) =>
					new StorageError({ operation: 'create upload session', cause })
			}).pipe(
				Effect.catch((failure) =>
					blobs
						.abortMultipart(r2Key, uploadId)
						.pipe(Effect.ignore, Effect.andThen(Effect.fail(failure)))
				)
			);
			return {
				sessionId,
				fileId,
				partSize,
				partCount,
				expiresAt: sessionExpiresAt
			};
		}),
		uploadPart: Effect.fn('Uploads.uploadPart')(function* (input) {
			const session = yield* loadSession(input.sessionId);
			yield* assertOpen(session);
			const partCount = partCountFor(
				session.expected_size_bytes,
				session.part_size_bytes
			);
			yield* validate(() => validatePartNumber(input.partNumber, partCount));
			const expected = expectedPartSize(
				input.partNumber,
				session.expected_size_bytes,
				session.part_size_bytes,
				partCount
			);
			const size = yield* validate(() =>
				validatePartLength(input.contentLength, expected)
			);
			const body =
				input.body ??
				new ReadableStream<Uint8Array>({
					start(controller) {
						controller.close();
					}
				});
			const part = yield* blobs.uploadPart(
				session.r2_key,
				session.r2_upload_id,
				input.partNumber,
				body,
				size
			);
			yield* Effect.tryPromise({
				try: () =>
					db
						.prepare(
							`INSERT INTO upload_parts (session_id, part_number, etag, size_bytes)
							VALUES (?, ?, ?, ?)
							ON CONFLICT(session_id, part_number)
							DO UPDATE SET etag = excluded.etag, size_bytes = excluded.size_bytes`
						)
						.bind(session.id, input.partNumber, part.etag, size)
						.run(),
				catch: (cause) =>
					new StorageError({ operation: 'record upload part', cause })
			});
			return { partNumber: input.partNumber, etag: part.etag, sizeBytes: size };
		}),
		complete: Effect.fn('Uploads.complete')(function* (sessionId) {
			const session = yield* loadSession(sessionId);
			yield* assertOpen(session);
			const partCount = partCountFor(
				session.expected_size_bytes,
				session.part_size_bytes
			);
			const partRows = yield* Effect.tryPromise({
				try: async () => {
					const result = await db
						.prepare(
							`SELECT part_number, etag, size_bytes FROM upload_parts
							WHERE session_id = ? ORDER BY part_number`
						)
						.bind(session.id)
						.all();
					if (!result.success) throw new Error(result.error ?? 'load parts');
					return result.results;
				},
				catch: (cause) =>
					new StorageError({ operation: 'load upload parts', cause })
			});
			const parts = decodeRows(PartRow, partRows);
			const total = parts.reduce((sum, part) => sum + part.size_bytes, 0);
			const numbersOk =
				parts.length === partCount &&
				parts.every((part, index) => part.part_number === index + 1);
			if (!numbersOk || total !== session.expected_size_bytes) {
				return yield* new InvalidRequest({
					status: 409,
					message: 'Uploaded parts are incomplete; upload every part first'
				});
			}

			const stored = yield* blobs.completeMultipart(
				session.r2_key,
				session.r2_upload_id,
				parts.map((part) => ({
					partNumber: part.part_number,
					etag: part.etag
				}))
			);

			const visibility = visibilityForFile(
				session.display_name,
				session.content_type,
				session.public === 1
			);
			const resolvedTags = yield* tags
				.resolveNames(decodeTagNames(session.tags))
				.pipe(Effect.catchTag('InvalidRequest', () => Effect.succeed([])));
			const now = new Date().toISOString();
			const exists = `EXISTS (SELECT 1 FROM upload_sessions WHERE id = ? AND status = 'complete')`;
			const statements = [
				db
					.prepare(
						`UPDATE upload_sessions SET status = 'complete'
						WHERE id = ? AND status = 'open'`
					)
					.bind(session.id),
				db
					.prepare(
						`INSERT INTO files (
							id, display_name, content_type, kind, current_version, size_bytes,
							public, is_site, created_at, updated_at, expires_at, index_state
						)
						SELECT ?, ?, ?, 'file', 1, ?, ?, 0, ?, ?, ?, 'pending'
						WHERE ${exists}`
					)
					.bind(
						session.file_id,
						session.display_name,
						session.content_type,
						stored.size,
						visibility.public ? 1 : 0,
						now,
						now,
						session.file_expires_at,
						session.id
					),
				db
					.prepare(
						`INSERT INTO file_versions (
							file_id, version, r2_key, size_bytes, sha256, content_type,
							created_at, text_content
						)
						SELECT ?, 1, ?, ?, NULL, ?, ?, NULL
						WHERE ${exists}`
					)
					.bind(
						session.file_id,
						session.r2_key,
						stored.size,
						session.content_type,
						now,
						session.id
					),
				...resolvedTags.map((tag) =>
					db
						.prepare(
							`INSERT INTO file_tags (file_id, tag_id)
							SELECT ?, ? WHERE ${exists}`
						)
						.bind(session.file_id, tag.id, session.id)
				),
				...fileIndexStatements(db, session.file_id),
				db
					.prepare('DELETE FROM upload_parts WHERE session_id = ?')
					.bind(session.id)
			];
			yield* Effect.tryPromise({
				try: async () => {
					const results = await db.batch(statements);
					if (results[0]?.meta.changes !== 1) {
						throw new Error('The upload session changed while finalizing');
					}
				},
				catch: (cause) =>
					new StorageError({ operation: 'finalize upload', cause })
			}).pipe(
				Effect.catch((failure) =>
					// The R2 object is already assembled but no file row references
					// it; drop the orphan before surfacing the failure.
					blobs
						.delete(session.r2_key)
						.pipe(Effect.ignore, Effect.andThen(Effect.fail(failure)))
				)
			);
			forgetTagListCache(db);
			return {
				file: {
					id: session.file_id,
					displayName: session.display_name,
					contentType: session.content_type,
					kind: 'file',
					version: 1,
					sizeBytes: stored.size,
					public: visibility.public,
					createdAt: now,
					expiresAt: session.file_expires_at,
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
		abort: Effect.fn('Uploads.abort')(function* (sessionId) {
			const session = yield* loadSession(sessionId);
			if (session.status === 'complete') {
				return yield* new NotFound({ id: sessionId });
			}
			yield* blobs
				.abortMultipart(session.r2_key, session.r2_upload_id)
				.pipe(Effect.ignore);
			yield* Effect.tryPromise({
				try: () =>
					db
						.prepare(
							`UPDATE upload_sessions SET status = 'aborted'
							WHERE id = ? AND status IN ('open', 'committing')`
						)
						.bind(session.id)
						.run(),
				catch: (cause) =>
					new StorageError({ operation: 'abort upload session', cause })
			});
		}),
		sweep: Effect.fn('Uploads.sweep')(function* (limit) {
			const bounded = Math.max(1, Math.min(limit, 25));
			const now = new Date().toISOString();
			const rows = yield* Effect.tryPromise({
				try: async () => {
					const result = await db
						.prepare(
							`SELECT id, file_id, r2_key, display_name, content_type, public,
								expected_size_bytes, part_size_bytes, r2_upload_id, status,
								expires_at, tags, file_expires_at
							FROM upload_sessions
							WHERE status = 'open' AND expires_at <= ?
							ORDER BY expires_at LIMIT ?`
						)
						.bind(now, bounded)
						.all();
					if (!result.success) throw new Error(result.error ?? 'sweep');
					return result.results;
				},
				catch: (cause) =>
					new StorageError({ operation: 'list expired upload sessions', cause })
			});
			const sessions = decodeRows(SessionRow, rows);
			for (const session of sessions) {
				yield* blobs
					.abortMultipart(session.r2_key, session.r2_upload_id)
					.pipe(Effect.ignore);
				yield* Effect.tryPromise({
					try: () =>
						db
							.prepare(
								`UPDATE upload_sessions SET status = 'aborted'
								WHERE id = ? AND status = 'open'`
							)
							.bind(session.id)
							.run(),
					catch: (cause) =>
						new StorageError({
							operation: 'expire upload session',
							cause
						})
				});
			}
			return sessions.length;
		})
	});
});

const decodeTagNames = (value: string): ReadonlyArray<string> => {
	try {
		const parsed: unknown = JSON.parse(value);
		return Array.isArray(parsed)
			? parsed.filter((entry): entry is string => typeof entry === 'string')
			: [];
	} catch {
		return [];
	}
};

export const UploadsLive = Layer.effect(Uploads, makeUploads);
