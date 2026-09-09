import type { PgClient } from '@effect/sql-pg';
import { Effect, Schema } from 'effect';
import { queueDeferredBlobDelete } from '../../blob-compensation';
import { AppConfig } from '../../config';
import { NotFound, StorageError } from '../../errors';
import { siteCleanupDisposition } from '../../site-policy';
import { Blobs } from '../blobs';
import type { CurrentOrg } from '../current-org';
import {
	PendingDeleteRow,
	SiteSessionRow,
	StagedAssetRow,
	decodeRows
} from './types';

interface CoreDeps {
	readonly sql: PgClient.PgClient;
	readonly blobs: Blobs['Service'];
	readonly config: AppConfig['Service'];
	readonly org: CurrentOrg['Service'];
}

export const createInternals = ({ sql, blobs, config, org }: CoreDeps) => {
	const all = <A, I>(
		statement: Effect.Effect<ReadonlyArray<unknown>, unknown>,
		schema: Schema.Codec<A, I, never>,
		operation: string
	) =>
		statement.pipe(
			Effect.mapError((cause) => new StorageError({ operation, cause })),
			Effect.map((rows) => decodeRows(schema, rows)),
			Effect.withSpan('Sites.all')
		);

	const findSession = Effect.fn('Sites.findSession')(function* (
		sessionId: string
	) {
		const rows = yield* all(
			sql`
				SELECT id, file_id, display_name, version, status, created_at, expires_at
				FROM site_upload_sessions
				WHERE id = ${sessionId}
				LIMIT 1`,
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
			sql`
				SELECT path, expected_size_bytes, content_type, r2_key,
					stored_size_bytes
				FROM staged_site_assets
				WHERE session_id = ${sessionId}
				ORDER BY path`,
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
		const rows = yield* sql<{ count: number }>`
			SELECT COUNT(*) AS count
			FROM pending_site_asset_deletes
			WHERE file_id = ${fileId}`.pipe(
			Effect.mapError(
				(cause) =>
					new StorageError({ operation: 'count pending site cleanup', cause })
			)
		);
		return (rows[0]?.count ?? 0) > 0;
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
					queueDeferredBlobDelete(
						sql,
						r2Key,
						session.fileId,
						session.version,
						new Date().toISOString(),
						String(deleteCause)
					).pipe(
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
			sql`
				SELECT r2_key
				FROM pending_site_asset_deletes
				WHERE file_id = ${fileId}
				ORDER BY queued_at
				LIMIT 500`,
			PendingDeleteRow,
			'list pending site cleanup'
		);
		const keys = rows.map((row) => row.r2_key);
		if (keys.length === 0) return false;

		const deleted = yield* blobs.deleteMany(keys).pipe(
			Effect.as(true),
			Effect.catch((failure) =>
				sql`
					UPDATE pending_site_asset_deletes
					SET attempts = attempts + 1, last_error = ${String(failure.cause)}
					WHERE file_id = ${fileId}`.pipe(
					Effect.mapError(
						(cause) =>
							new StorageError({
								operation: 'record site cleanup failure',
								cause
							})
					),
					Effect.as(false)
				)
			)
		);
		const disposition = siteCleanupDisposition(keys, deleted);
		if (disposition.remainsPending) return true;

		yield* sql`
			DELETE FROM pending_site_asset_deletes
			WHERE r2_key = ANY(${disposition.deleteFromQueue}::text[])`.pipe(
			Effect.mapError(
				(cause) =>
					new StorageError({ operation: 'finish site asset cleanup', cause })
			)
		);
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
		yield* sql
			.withTransaction(
				Effect.gen(function* () {
					// Claim cleanup before reading keys. A concurrent publisher owns
					// this row until commit; after it completes, its blobs are live.
					const claimed = yield* sql<{ id: string }>`
						UPDATE site_upload_sessions SET status = ${status}
						WHERE id = ${session.id} AND status IN ('open', 'committing')
						RETURNING id`;
					if (claimed.length === 0) return;
					yield* sql`
						INSERT INTO pending_site_asset_deletes (
							r2_key, file_id, version, queued_at
						)
						SELECT r2_key, ${session.fileId}, ${session.version}, ${now}
						FROM staged_site_assets
						WHERE session_id = ${session.id} AND r2_key IS NOT NULL
						ON CONFLICT (r2_key) DO NOTHING`;
					yield* sql`
						DELETE FROM staged_site_assets WHERE session_id = ${session.id}`;
				})
			)
			.pipe(
				Effect.mapError(
					(cause) =>
						new StorageError({ operation: 'clean staged site assets', cause })
				)
			);
		yield* drainDeletes(session.fileId);
	});

	const sweepExpiredSessions = Effect.fn('Sites.sweepExpiredSessions')(
		function* (limit = 10) {
			const now = new Date().toISOString();
			const bounded = Math.max(1, Math.min(limit, 25));
			const rows = yield* all(
				sql`
					SELECT id, file_id, display_name, version, status, created_at,
						expires_at
					FROM site_upload_sessions
					WHERE status = 'open' AND expires_at <= ${now}
					ORDER BY expires_at
					LIMIT ${bounded}`,
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
		const rows = yield* sql<{ file_id: string }>`
			SELECT file_id
			FROM pending_site_asset_deletes
			GROUP BY file_id
			ORDER BY MIN(queued_at)
			LIMIT ${bounded}`.pipe(
			Effect.mapError(
				(cause) =>
					new StorageError({ operation: 'list pending site cleanup', cause })
			)
		);
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
		sql,
		blobs,
		config,
		org
	};
};

export type SiteInternals = ReturnType<typeof createInternals>;
