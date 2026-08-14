export interface ThumbnailStorageCommand {
	readonly sql: string;
	readonly bindings: ReadonlyArray<string | number | null>;
}

export const thumbnailStorageStateCommand = (
	fileId: string,
	version: number
): ThumbnailStorageCommand => ({
	sql: `SELECT v.thumbnail_r2_key, v.thumbnail_size_bytes
		FROM file_versions v
		JOIN files f ON f.id = v.file_id
		WHERE v.file_id = ? AND v.version = ?
			AND f.purge_state = 'none'
		LIMIT 1`,
	bindings: [fileId, version]
});

export const commitThumbnailStorageCommand = (
	fileId: string,
	version: number,
	r2Key: string,
	size: number,
	expectedR2Key: string | null
): ThumbnailStorageCommand => ({
	sql: `UPDATE file_versions
		SET thumbnail_r2_key = ?, thumbnail_size_bytes = ?
		WHERE file_id = ? AND version = ?
			AND (
				(thumbnail_r2_key IS NULL AND ? IS NULL)
				OR thumbnail_r2_key = ?
			)
			AND EXISTS (
				SELECT 1
				FROM files f
				WHERE f.id = file_versions.file_id
					AND f.purge_state = 'none'
			)`,
	bindings: [r2Key, size, fileId, version, expectedR2Key, expectedR2Key]
});

export const thumbnailQuotaDelta = (storedSize: number, incomingSize: number) =>
	Math.max(0, incomingSize - storedSize);
