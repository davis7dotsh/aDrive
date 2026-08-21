import { Effect, Schema } from 'effect';
import { AppConfig } from '../../config';
import { NotFound, StorageError } from '../../errors';
import { siteCleanupDisposition } from '../../site-policy';
import { Blobs } from '../blobs';
import { Db } from '../bindings';
import {
	PendingDeleteRow,
	SiteSessionRow,
	StagedAssetRow,
	decodeRows
} from './types';

interface CoreDeps {
	readonly db: Db['Service'];
	readonly blobs: Blobs['Service'];
	readonly config: AppConfig['Service'];
}

export const createInternals = ({ db, blobs, config }: CoreDeps) => {
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

	return {
		all,
		findSession,
		stagedAssets,
		pendingDeleteCount,
		compensateStagedBlob,
		drainDeletes,
		cleanupStaged,
		sweepExpiredSessions,
		sweepPendingDeletes,
		db,
		blobs,
		config
	};
};

export type SiteInternals = ReturnType<typeof createInternals>;
