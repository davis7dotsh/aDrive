import type { PgClient } from '@effect/sql-pg';
import { Effect } from 'effect';

export interface ThumbnailStorageState {
	readonly thumbnail_r2_key: string | null;
	readonly thumbnail_size_bytes: number;
}

// A thumbnail only attaches to a version whose file is not being purged;
// a purge that has claimed the file wins over any in-flight render.
export const thumbnailStorageState = (
	sql: PgClient.PgClient,
	orgId: string,
	fileId: string,
	version: number
) =>
	sql<ThumbnailStorageState>`
		SELECT v.thumbnail_r2_key, v.thumbnail_size_bytes
		FROM file_versions v
		JOIN files f ON f.id = v.file_id
		WHERE v.file_id = ${fileId} AND v.org_id = ${orgId} AND v.version = ${version}
			AND f.purge_state = 'none'
		LIMIT 1`.pipe(Effect.map((rows) => rows[0] ?? null));

// Compare-and-set on the stored key: only the writer whose expectation
// matches the current key commits, so concurrent renders keep one blob.
// Resolves to whether this writer won.
export const commitThumbnailStorage = (
	sql: PgClient.PgClient,
	orgId: string,
	fileId: string,
	version: number,
	r2Key: string,
	size: number,
	expectedR2Key: string | null
) =>
	sql<{ file_id: string }>`
		UPDATE file_versions
		SET thumbnail_r2_key = ${r2Key}, thumbnail_size_bytes = ${size}
		WHERE file_id = ${fileId} AND org_id = ${orgId} AND version = ${version}
			AND thumbnail_r2_key IS NOT DISTINCT FROM ${expectedR2Key}::text
			AND EXISTS (
				SELECT 1 FROM files f
				WHERE f.id = file_versions.file_id AND f.purge_state = 'none'
			)
		RETURNING file_id`.pipe(Effect.map((rows) => rows.length === 1));

export const thumbnailQuotaDelta = (storedSize: number, incomingSize: number) =>
	Math.max(0, incomingSize - storedSize);
