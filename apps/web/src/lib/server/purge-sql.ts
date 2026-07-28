export type PurgeSqlBinding = string | number | null;

export interface PurgeSqlCommand {
	readonly sql: string;
	readonly bindings: ReadonlyArray<PurgeSqlBinding>;
}

export const purgeCompletionCommands = (
	fileId: string,
	queuedAt: string
): ReadonlyArray<PurgeSqlCommand> => [
	{
		sql: `INSERT INTO pending_vector_deletes (vector_id, queued_at)
			SELECT vector_id, ? FROM file_chunks
			WHERE file_id = ?
				AND EXISTS (
					SELECT 1 FROM files
					WHERE id = ? AND purge_state = 'pending'
				)
			ON CONFLICT(vector_id) DO NOTHING`,
		bindings: [queuedAt, fileId, fileId]
	},
	{
		sql: `DELETE FROM files_fts
			WHERE file_id = ?
				AND EXISTS (
					SELECT 1 FROM files
					WHERE id = ? AND purge_state = 'pending'
				)`,
		bindings: [fileId, fileId]
	},
	{
		sql: `DELETE FROM files_trgm
			WHERE file_id = ?
				AND EXISTS (
					SELECT 1 FROM files
					WHERE id = ? AND purge_state = 'pending'
				)`,
		bindings: [fileId, fileId]
	},
	{
		sql: `UPDATE files
			SET purge_state = 'done', purge_error = NULL,
				purge_next_run_at = NULL
			WHERE id = ? AND purge_state = 'pending'`,
		bindings: [fileId]
	},
	{
		sql: `DELETE FROM files
			WHERE id = ? AND purge_state = 'done'`,
		bindings: [fileId]
	}
];
