export interface ThumbnailStorageCommand {
	readonly sql: string;
	readonly bindings: ReadonlyArray<string | number>;
}

export const thumbnailStorageStateCommand = (
	fileId: string,
	version: number,
	now: string
): ThumbnailStorageCommand => ({
	sql: `SELECT v.thumbnail_size_bytes
		FROM file_versions v
		JOIN files f ON f.id = v.file_id
		WHERE v.file_id = ? AND v.version = ?
			AND f.deleted_at IS NULL
			AND (f.expires_at IS NULL OR f.expires_at > ?)
			AND f.purge_state = 'none'
		LIMIT 1`,
	bindings: [fileId, version, now]
});

export const commitThumbnailStorageCommand = (
	fileId: string,
	version: number,
	size: number,
	now: string
): ThumbnailStorageCommand => ({
	sql: `UPDATE file_versions
		SET thumbnail_size_bytes = ?
		WHERE file_id = ? AND version = ?
			AND EXISTS (
				SELECT 1
				FROM files f
				WHERE f.id = file_versions.file_id
					AND f.deleted_at IS NULL
					AND (f.expires_at IS NULL OR f.expires_at > ?)
					AND f.purge_state = 'none'
			)`,
	bindings: [size, fileId, version, now]
});

export const thumbnailQuotaDelta = (storedSize: number, incomingSize: number) =>
	Math.max(0, incomingSize - storedSize);
