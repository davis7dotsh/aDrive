import {
	normalizeSitePath,
	sitePathCandidates,
	type FileSummary,
	type SiteManifestAsset,
	type SiteSessionCreate
} from '@adrive/shared';
import { Context, Effect, Layer, Schema } from 'effect';
import { AppConfig } from '../config';
import { InvalidRequest, NotFound, StorageError } from '../errors';
import { fileIndexStatements } from '../search-index';
import { ensureStorageQuota } from '../storage-quota';
import {
	assertOpenSiteSession,
	prepareSiteManifest,
	SITE_SESSION_TTL_MS,
	siteCleanupDisposition,
	validateCommittedAssets
} from '../site-policy';
import { validateUploadLength } from '../upload-stream';
import { Blobs } from './blobs';
import { Db } from './bindings';

const SiteSessionRow = Schema.Struct({
	id: Schema.String,
	file_id: Schema.String,
	display_name: Schema.String,
	version: Schema.Int,
	status: Schema.String,
	created_at: Schema.String,
	expires_at: Schema.String
});

const StagedAssetRow = Schema.Struct({
	path: Schema.String,
	expected_size_bytes: Schema.Int,
	content_type: Schema.String,
	r2_key: Schema.NullOr(Schema.String),
	stored_size_bytes: Schema.NullOr(Schema.Int)
});

const ExistingSiteRow = Schema.Struct({
	id: Schema.String,
	display_name: Schema.String,
	current_version: Schema.Int
});

const SiteFileRow = Schema.Struct({
	id: Schema.String,
	display_name: Schema.String,
	current_version: Schema.Int,
	size_bytes: Schema.Int,
	created_at: Schema.String,
	expires_at: Schema.NullOr(Schema.String),
	download_count: Schema.Int,
	last_download_at: Schema.NullOr(Schema.String)
});

const SiteAssetRow = Schema.Struct({
	path: Schema.String,
	r2_key: Schema.String,
	content_type: Schema.String,
	size_bytes: Schema.Int
});

const PendingDeleteRow = Schema.Struct({
	r2_key: Schema.String
});

const decodeRows = <A, I>(schema: Schema.Codec<A, I, never>, rows: unknown) => {
	const decoded = Schema.decodeUnknownOption(Schema.Array(schema))(rows);
	return decoded._tag === 'Some' ? decoded.value : [];
};

interface StageAssetInput {
	readonly sessionId: string;
	readonly path: string;
	readonly contentLength: string | null;
	readonly body: ReadableStream<Uint8Array> | null;
}

export interface SiteSession {
	readonly sessionId: string;
	readonly fileId: string;
	readonly version: number;
	readonly expiresAt: string;
}

export interface SiteCommitResult {
	readonly file: FileSummary;
	readonly assetCount: number;
	readonly cleanupPending: boolean;
}

export interface SiteContent {
	readonly path: string;
	readonly r2Key: string;
	readonly contentType: string;
	readonly sizeBytes: number;
}

export interface SitesShape {
	readonly createSession: (
		input: SiteSessionCreate
	) => Effect.Effect<SiteSession, InvalidRequest | NotFound | StorageError>;
	readonly stageAsset: (input: StageAssetInput) => Effect.Effect<
		{
			readonly path: string;
			readonly sizeBytes: number;
			readonly contentType: string;
		},
		InvalidRequest | NotFound | StorageError
	>;
	readonly commit: (
		sessionId: string
	) => Effect.Effect<
		SiteCommitResult,
		InvalidRequest | NotFound | StorageError
	>;
	readonly abort: (
		sessionId: string
	) => Effect.Effect<void, NotFound | StorageError>;
	readonly findAsset: (
		fileId: string,
		requestPath: string,
		options?: {
			readonly includeUnavailable?: boolean;
			readonly version?: number;
		}
	) => Effect.Effect<SiteContent, InvalidRequest | NotFound | StorageError>;
	readonly sweepLifecycle: (
		limit: number
	) => Effect.Effect<number, StorageError>;
}

export class Sites extends Context.Service<Sites, SitesShape>()('app/Sites') {}

const makeSites = Effect.gen(function* () {
	const db = yield* Db;
	const blobs = yield* Blobs;
	const config = yield* AppConfig;

	const all = Effect.fn('Sites.all')(function* <A, I>(
		statement: D1PreparedStatement,
		schema: Schema.Codec<A, I, never>,
		operation: string
	) {
		const rows = yield* Effect.tryPromise({
			try: async () => {
				const result = await statement.all();
				if (!result.success) throw new Error(result.error ?? operation);
				return result.results;
			},
			catch: (cause) => new StorageError({ operation, cause })
		});
		return decodeRows(schema, rows);
	});

	const findSession = Effect.fn('Sites.findSession')(function* (
		sessionId: string
	) {
		const rows = yield* all(
			db
				.prepare(
					`SELECT id, file_id, display_name, version, status, created_at, expires_at
					FROM site_upload_sessions
					WHERE id = ?
					LIMIT 1`
				)
				.bind(sessionId),
			SiteSessionRow,
			'find site upload session'
		);
		const row = rows[0];
		if (!row) return yield* new NotFound({ id: sessionId });
		return {
			id: row.id,
			fileId: row.file_id,
			displayName: row.display_name,
			version: row.version,
			status: row.status,
			createdAt: row.created_at,
			expiresAt: row.expires_at
		};
	});

	const stagedAssets = Effect.fn('Sites.stagedAssets')(function* (
		sessionId: string
	) {
		const rows = yield* all(
			db
				.prepare(
					`SELECT path, expected_size_bytes, content_type, r2_key,
						stored_size_bytes
					FROM staged_site_assets
					WHERE session_id = ?
					ORDER BY path`
				)
				.bind(sessionId),
			StagedAssetRow,
			'list staged site assets'
		);
		return rows.map((row) => ({
			path: row.path,
			expectedSizeBytes: row.expected_size_bytes,
			contentType: row.content_type,
			r2Key: row.r2_key,
			storedSizeBytes: row.stored_size_bytes
		}));
	});

	const pendingDeleteCount = Effect.fn('Sites.pendingDeleteCount')(function* (
		fileId: string
	) {
		const result = yield* Effect.tryPromise({
			try: () =>
				db
					.prepare(
						'SELECT COUNT(*) AS count FROM pending_site_asset_deletes WHERE file_id = ?'
					)
					.bind(fileId)
					.first<{ count: number }>(),
			catch: (cause) =>
				new StorageError({ operation: 'count pending site cleanup', cause })
		});
		return (result?.count ?? 0) > 0;
	});

	const compensateStagedBlob = Effect.fn('Sites.compensateStagedBlob')(
		function* (
			session: {
				readonly fileId: string;
				readonly version: number;
			},
			r2Key: string
		) {
			yield* blobs.delete(r2Key).pipe(
				Effect.catchCause((deleteCause) =>
					Effect.tryPromise({
						try: () =>
							db
								.prepare(
									`INSERT INTO pending_site_asset_deletes (
										r2_key, file_id, version, queued_at, attempts, last_error
									) VALUES (?, ?, ?, ?, 1, ?)
									ON CONFLICT(r2_key) DO NOTHING`
								)
								.bind(
									r2Key,
									session.fileId,
									session.version,
									new Date().toISOString(),
									String(deleteCause)
								)
								.run(),
						catch: (queueCause) =>
							new StorageError({
								operation: 'queue orphaned staged site asset',
								cause: queueCause
							})
					}).pipe(
						Effect.catchCause((queueCause) =>
							Effect.sync(() => {
								console.error(
									JSON.stringify({
										message:
											'staged site asset compensation could not be recorded',
										r2Key,
										deleteCause: String(deleteCause),
										queueCause: String(queueCause)
									})
								);
							})
						)
					)
				)
			);
		}
	);

	const drainDeletes = Effect.fn('Sites.drainDeletes')(function* (
		fileId: string
	) {
		const rows = yield* all(
			db
				.prepare(
					`SELECT r2_key
					FROM pending_site_asset_deletes
					WHERE file_id = ?
					ORDER BY queued_at
					LIMIT 500`
				)
				.bind(fileId),
			PendingDeleteRow,
			'list pending site cleanup'
		);
		const keys = rows.map((row) => row.r2_key);
		if (keys.length === 0) return false;

		const deleted = yield* blobs.deleteMany(keys).pipe(
			Effect.as(true),
			Effect.catch((failure) =>
				Effect.tryPromise({
					try: () =>
						db
							.prepare(
								`UPDATE pending_site_asset_deletes
								SET attempts = attempts + 1, last_error = ?
								WHERE file_id = ?`
							)
							.bind(String(failure.cause), fileId)
							.run(),
					catch: (cause) =>
						new StorageError({
							operation: 'record site cleanup failure',
							cause
						})
				}).pipe(Effect.as(false))
			)
		);
		const disposition = siteCleanupDisposition(keys, deleted);
		if (disposition.remainsPending) return true;

		const statements = Array.from(
			{ length: Math.ceil(disposition.deleteFromQueue.length / 80) },
			(_, index) => {
				const chunk = disposition.deleteFromQueue.slice(
					index * 80,
					index * 80 + 80
				);
				return db
					.prepare(
						`DELETE FROM pending_site_asset_deletes
						WHERE r2_key IN (${chunk.map(() => '?').join(', ')})`
					)
					.bind(...chunk);
			}
		);
		yield* Effect.tryPromise({
			try: () => db.batch(statements),
			catch: (cause) =>
				new StorageError({ operation: 'finish site asset cleanup', cause })
		});
		return yield* pendingDeleteCount(fileId);
	});

	const cleanupStaged = Effect.fn('Sites.cleanupStaged')(function* (
		session: {
			readonly id: string;
			readonly fileId: string;
			readonly version: number;
		},
		status: 'aborted' | 'complete'
	) {
		const now = new Date().toISOString();
		yield* Effect.tryPromise({
			try: () =>
				db.batch([
					db
						.prepare(
							`INSERT INTO pending_site_asset_deletes (
								r2_key, file_id, version, queued_at
							)
							SELECT r2_key, ?, ?, ?
							FROM staged_site_assets
							WHERE session_id = ? AND r2_key IS NOT NULL
							ON CONFLICT(r2_key) DO NOTHING`
						)
						.bind(session.fileId, session.version, now, session.id),
					db
						.prepare(
							`UPDATE site_upload_sessions SET status = ?
							WHERE id = ? AND status IN ('open', 'committing')`
						)
						.bind(status, session.id),
					db
						.prepare('DELETE FROM staged_site_assets WHERE session_id = ?')
						.bind(session.id)
				]),
			catch: (cause) =>
				new StorageError({ operation: 'clean staged site assets', cause })
		});
		yield* drainDeletes(session.fileId);
	});

	const sweepExpiredSessions = Effect.fn('Sites.sweepExpiredSessions')(
		function* (limit = 10) {
			const now = new Date().toISOString();
			const bounded = Math.max(1, Math.min(limit, 25));
			const rows = yield* all(
				db
					.prepare(
						`SELECT id, file_id, display_name, version, status, created_at,
							expires_at
						FROM site_upload_sessions
						WHERE status = 'open' AND expires_at <= ?
						ORDER BY expires_at
						LIMIT ?`
					)
					.bind(now, bounded),
				SiteSessionRow,
				'list expired site upload sessions'
			);
			for (const row of rows) {
				yield* cleanupStaged(
					{
						id: row.id,
						fileId: row.file_id,
						version: row.version
					},
					'aborted'
				);
			}
			return rows.length;
		}
	);

	const sweepPendingDeletes = Effect.fn('Sites.sweepPendingDeletes')(function* (
		limit: number
	) {
		const bounded = Math.max(1, Math.min(limit, 25));
		const rows = yield* Effect.tryPromise({
			try: async () => {
				const result = await db
					.prepare(
						`SELECT DISTINCT file_id
							FROM pending_site_asset_deletes
							ORDER BY queued_at
							LIMIT ?`
					)
					.bind(bounded)
					.all<{ file_id: string }>();
				if (!result.success) {
					throw new Error(result.error ?? 'Site cleanup listing failed');
				}
				return result.results;
			},
			catch: (cause) =>
				new StorageError({ operation: 'list pending site cleanup', cause })
		});
		for (const row of rows) yield* drainDeletes(row.file_id);
		return rows.length;
	});

	return Sites.of({
		createSession: Effect.fn('Sites.createSession')(function* (input) {
			yield* sweepExpiredSessions().pipe(
				Effect.catchCause((cause) =>
					Effect.sync(() => {
						console.error(
							JSON.stringify({
								message: 'expired site session sweep failed',
								cause: String(cause)
							})
						);
					})
				)
			);
			const prepared = yield* Effect.try({
				try: () => prepareSiteManifest(input, config.maxUploadBytes),
				catch: (cause) =>
					cause instanceof InvalidRequest
						? cause
						: new InvalidRequest({
								status: 400,
								message: 'Site manifest is invalid'
							})
			});
			// Declared manifest sizes gate the whole publish before any asset
			// bytes are accepted; per-asset uploads re-verify actual lengths.
			const declaredBytes = prepared.assets.reduce(
				(total, asset) => total + asset.sizeBytes,
				0
			);
			yield* ensureStorageQuota(db, config.maxTotalBytes, declaredBytes);

			let fileId: string = crypto.randomUUID();
			let version = 1;
			let displayName = prepared.displayName;
			if (input.fileId !== undefined) {
				const rows = yield* all(
					db
						.prepare(
							`SELECT id, display_name, current_version
							FROM files
							WHERE id = ? AND is_site = 1 AND deleted_at IS NULL
							LIMIT 1`
						)
						.bind(input.fileId),
					ExistingSiteRow,
					'find site to republish'
				);
				const current = rows[0];
				if (!current) return yield* new NotFound({ id: input.fileId });
				fileId = current.id;
				version = current.current_version + 1;
				displayName = current.display_name;
			}

			const id = crypto.randomUUID();
			const createdAt = new Date().toISOString();
			const expiresAt = new Date(
				new Date(createdAt).getTime() + SITE_SESSION_TTL_MS
			).toISOString();
			const statements = [
				db
					.prepare(
						`INSERT INTO site_upload_sessions (
							id, file_id, display_name, version, status, created_at, expires_at
						) VALUES (?, ?, ?, ?, 'open', ?, ?)`
					)
					.bind(id, fileId, displayName, version, createdAt, expiresAt),
				...prepared.assets.map((asset) =>
					db
						.prepare(
							`INSERT INTO staged_site_assets (
								session_id, path, expected_size_bytes, content_type
							) VALUES (?, ?, ?, ?)`
						)
						.bind(id, asset.path, asset.sizeBytes, asset.contentType)
				)
			];
			yield* Effect.tryPromise({
				try: () => db.batch(statements),
				catch: (cause) =>
					new StorageError({ operation: 'create site upload session', cause })
			});
			yield* drainDeletes(fileId).pipe(
				Effect.catchCause((cause) =>
					Effect.sync(() => {
						console.error(
							JSON.stringify({
								message: 'deferred site cleanup retry failed',
								fileId,
								cause: String(cause)
							})
						);
					})
				)
			);
			return { sessionId: id, fileId, version, expiresAt };
		}),
		stageAsset: Effect.fn('Sites.stageAsset')(function* (input) {
			const session = yield* findSession(input.sessionId);
			yield* Effect.try({
				try: () => assertOpenSiteSession(session, new Date()),
				catch: (cause) =>
					cause instanceof InvalidRequest
						? cause
						: new InvalidRequest({
								status: 409,
								message: 'Site upload session is unavailable'
							})
			});
			const path = yield* Effect.try({
				try: () => normalizeSitePath(input.path),
				catch: () =>
					new InvalidRequest({
						status: 400,
						message: 'Site asset path is unsafe'
					})
			});
			const assets = yield* stagedAssets(session.id);
			const asset = assets.find((candidate) => candidate.path === path);
			if (!asset) return yield* new NotFound({ id: path });
			if (asset.r2Key !== null) {
				return yield* new InvalidRequest({
					status: 409,
					message: 'Site asset was already uploaded'
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
								message: 'Site asset length is invalid'
							})
			});
			if (size !== asset.expectedSizeBytes) {
				return yield* new InvalidRequest({
					status: 409,
					message: 'Site asset length does not match the manifest'
				});
			}

			const r2Key = `s/${session.fileId}/${session.version}/${crypto.randomUUID()}`;
			const stored = yield* blobs.put(
				r2Key,
				input.body,
				size,
				asset.contentType
			);
			const uploadedAt = new Date().toISOString();
			const update = yield* Effect.tryPromise({
				try: () =>
					db
						.prepare(
							`UPDATE staged_site_assets
							SET r2_key = ?, stored_size_bytes = ?, uploaded_at = ?
							WHERE session_id = ? AND path = ? AND r2_key IS NULL
								AND EXISTS (
									SELECT 1 FROM site_upload_sessions
									WHERE id = ? AND status = 'open' AND expires_at > ?
								)`
						)
						.bind(
							r2Key,
							stored.size,
							uploadedAt,
							session.id,
							path,
							session.id,
							uploadedAt
						)
						.run(),
				catch: (cause) =>
					new StorageError({ operation: 'record staged site asset', cause })
			}).pipe(
				Effect.catch((failure) =>
					compensateStagedBlob(session, r2Key).pipe(
						Effect.andThen(Effect.fail(failure))
					)
				)
			);
			if (update.meta.changes !== 1) {
				yield* compensateStagedBlob(session, r2Key);
				return yield* new InvalidRequest({
					status: 409,
					message: 'Site upload session changed while the asset was uploading'
				});
			}
			return { path, sizeBytes: stored.size, contentType: asset.contentType };
		}),
		commit: Effect.fn('Sites.commit')(function* (sessionId) {
			const session = yield* findSession(sessionId);
			yield* Effect.try({
				try: () => assertOpenSiteSession(session, new Date()),
				catch: (cause) =>
					cause instanceof InvalidRequest
						? cause
						: new InvalidRequest({
								status: 409,
								message: 'Site upload session is unavailable'
							})
			});
			const assets = yield* stagedAssets(session.id);
			const totalSize = yield* Effect.try({
				try: () => validateCommittedAssets(assets),
				catch: (cause) =>
					cause instanceof InvalidRequest
						? cause
						: new InvalidRequest({
								status: 409,
								message: 'Site assets are incomplete'
							})
			});
			const publishedAt = new Date().toISOString();
			const versionKey = `site-version/${session.fileId}/${session.version}/${session.id}`;
			const guard =
				session.version === 1
					? db
							.prepare(
								`UPDATE site_upload_sessions
								SET status = 'committing'
								WHERE id = ? AND status = 'open' AND expires_at > ?
									AND NOT EXISTS (SELECT 1 FROM files WHERE id = ?)`
							)
							.bind(session.id, publishedAt, session.fileId)
					: db
							.prepare(
								`UPDATE site_upload_sessions
								SET status = 'committing'
								WHERE id = ? AND status = 'open' AND expires_at > ?
									AND EXISTS (
										SELECT 1 FROM files
										WHERE id = ? AND is_site = 1 AND deleted_at IS NULL
											AND current_version = ?
									)`
							)
							.bind(
								session.id,
								publishedAt,
								session.fileId,
								session.version - 1
							);
			const statements = [
				guard,
				db
					.prepare(
						`INSERT INTO files (
							id, display_name, content_type, kind, current_version, size_bytes,
							public, is_site, created_at, updated_at, index_state
						)
						SELECT file_id, display_name, 'text/html', 'site', 1, ?, 1, 1,
							?, ?, 'pending'
						FROM site_upload_sessions
						WHERE id = ? AND status = 'committing' AND version = 1
						ON CONFLICT(id) DO NOTHING`
					)
					.bind(totalSize, publishedAt, publishedAt, session.id),
				db
					.prepare(
						`UPDATE files
						SET current_version = ?, size_bytes = ?, content_type = 'text/html',
							public = 1, updated_at = ?, index_state = 'pending',
							index_cursor = 0, index_attempts = 0, index_error = NULL,
							index_next_run_at = NULL, index_lease_token = NULL
						WHERE id = ? AND current_version = ? AND is_site = 1
							AND EXISTS (
								SELECT 1 FROM site_upload_sessions
								WHERE id = ? AND status = 'committing' AND version > 1
							)`
					)
					.bind(
						session.version,
						totalSize,
						publishedAt,
						session.fileId,
						session.version - 1,
						session.id
					),
				db
					.prepare(
						`INSERT INTO file_versions (
							file_id, version, r2_key, size_bytes, sha256, content_type,
							created_at, text_content
						)
						SELECT s.file_id, s.version, ?, ?, NULL, 'text/html', ?, NULL
						FROM site_upload_sessions s
						JOIN files f ON f.id = s.file_id
						WHERE s.id = ? AND s.status = 'committing'
							AND f.current_version = s.version`
					)
					.bind(versionKey, totalSize, publishedAt, session.id),
				db
					.prepare(
						`INSERT INTO pending_site_asset_deletes (
							r2_key, file_id, version, queued_at
						)
						SELECT old.r2_key, old.file_id, old.version, ?
						FROM site_assets old
						WHERE old.file_id = ? AND old.version <> ?
							AND EXISTS (
								SELECT 1 FROM site_upload_sessions
								WHERE id = ? AND status = 'committing'
							)
						ON CONFLICT(r2_key) DO NOTHING`
					)
					.bind(publishedAt, session.fileId, session.version, session.id),
				db
					.prepare(
						`DELETE FROM site_assets
						WHERE file_id = ? AND version <> ?
							AND EXISTS (
								SELECT 1 FROM site_upload_sessions
								WHERE id = ? AND status = 'committing'
							)`
					)
					.bind(session.fileId, session.version, session.id),
				db
					.prepare(
						`INSERT INTO site_assets (
							file_id, version, path, r2_key, content_type, size_bytes
						)
						SELECT s.file_id, s.version, a.path, a.r2_key, a.content_type,
							a.stored_size_bytes
						FROM site_upload_sessions s
						JOIN staged_site_assets a ON a.session_id = s.id
						WHERE s.id = ? AND s.status = 'committing'
							AND a.r2_key IS NOT NULL AND a.stored_size_bytes IS NOT NULL`
					)
					.bind(session.id),
				...fileIndexStatements(db, session.fileId),
				db
					.prepare(
						`UPDATE site_upload_sessions SET status = 'complete'
						WHERE id = ? AND status = 'committing'
							AND (
								SELECT COUNT(*) FROM staged_site_assets
								WHERE session_id = ?
							) = (
								SELECT COUNT(*) FROM site_assets
								WHERE file_id = ? AND version = ?
							)`
					)
					.bind(session.id, session.id, session.fileId, session.version),
				db
					.prepare(
						`DELETE FROM staged_site_assets
						WHERE session_id = ? AND EXISTS (
							SELECT 1 FROM site_upload_sessions
							WHERE id = ? AND status = 'complete'
						)`
					)
					.bind(session.id, session.id)
			];

			const commit = Effect.tryPromise({
				try: async () => {
					const results = await db.batch(statements);
					if (results[0]?.meta.changes !== 1) {
						throw new Error('The site changed while it was publishing');
					}
				},
				catch: (cause) =>
					new StorageError({ operation: 'commit site version', cause })
			});
			yield* commit.pipe(
				Effect.catch((failure) =>
					cleanupStaged(session, 'aborted').pipe(
						Effect.catchCause((cleanupCause) =>
							Effect.sync(() => {
								console.error(
									JSON.stringify({
										message: 'site publish compensation failed',
										sessionId,
										cause: String(cleanupCause)
									})
								);
							})
						),
						Effect.andThen(Effect.fail(failure))
					)
				)
			);

			const cleanupPending = yield* drainDeletes(session.fileId).pipe(
				Effect.catchCause((cause) =>
					Effect.sync(() => {
						console.error(
							JSON.stringify({
								message: 'published site cleanup remains pending',
								fileId: session.fileId,
								cause: String(cause)
							})
						);
						return true;
					})
				)
			);
			const rows = yield* all(
				db
					.prepare(
						`SELECT id, display_name, current_version, size_bytes, created_at,
							expires_at, download_count, last_download_at
						FROM files
						WHERE id = ? AND is_site = 1 AND current_version = ?
						LIMIT 1`
					)
					.bind(session.fileId, session.version),
				SiteFileRow,
				'read published site'
			);
			const file = rows[0];
			if (!file) {
				return yield* new StorageError({
					operation: 'read published site',
					cause: 'Committed site metadata was not found'
				});
			}
			return {
				file: {
					id: file.id,
					displayName: file.display_name,
					contentType: 'text/html',
					kind: 'site',
					version: file.current_version,
					sizeBytes: file.size_bytes,
					public: true,
					createdAt: file.created_at,
					expiresAt: file.expires_at,
					downloadCount: file.download_count,
					lastDownloadAt: file.last_download_at,
					indexState: 'pending',
					indexedVersion: null,
					indexAttempts: 0,
					indexError: null
				},
				assetCount: assets.length,
				cleanupPending
			};
		}),
		abort: Effect.fn('Sites.abort')(function* (sessionId) {
			const session = yield* findSession(sessionId);
			if (session.status === 'complete') {
				return yield* new NotFound({ id: sessionId });
			}
			yield* cleanupStaged(session, 'aborted');
		}),
		findAsset: Effect.fn('Sites.findAsset')(function* (
			fileId,
			requestPath,
			options = {}
		) {
			const candidates = yield* Effect.try({
				try: () => sitePathCandidates(requestPath),
				catch: () =>
					new InvalidRequest({
						status: 400,
						message: 'Site asset path is unsafe'
					})
			});
			const rows = yield* all(
				db
					.prepare(
						`SELECT a.path, a.r2_key, a.content_type, a.size_bytes
						FROM files f
						JOIN site_assets a
							ON a.file_id = f.id AND a.version = f.current_version
						WHERE f.id = ? AND f.is_site = 1 AND f.public = 1
							AND a.version = f.current_version
							AND (
								? = 1
								OR (
									f.deleted_at IS NULL
									AND (f.expires_at IS NULL OR f.expires_at > ?)
								)
							)
							AND (? = 0 OR a.version = ?)
							AND a.path IN (${candidates.map(() => '?').join(', ')})`
					)
					.bind(
						fileId,
						options.includeUnavailable ? 1 : 0,
						new Date().toISOString(),
						options.version === undefined ? 0 : 1,
						options.version ?? 0,
						...candidates
					),
				SiteAssetRow,
				'find site asset'
			);
			const byPath = new Map(rows.map((row) => [row.path, row]));
			const asset = candidates.flatMap((path) => {
				const value = byPath.get(path);
				return value ? [value] : [];
			})[0];
			if (!asset) return yield* new NotFound({ id: fileId });
			return {
				path: asset.path,
				r2Key: asset.r2_key,
				contentType: asset.content_type,
				sizeBytes: asset.size_bytes
			};
		}),
		sweepLifecycle: Effect.fn('Sites.sweepLifecycle')(function* (limit) {
			const expired = yield* sweepExpiredSessions(limit);
			const pending = yield* sweepPendingDeletes(limit);
			return expired + pending;
		})
	});
});

export const SitesLive = Layer.effect(Sites, makeSites);
