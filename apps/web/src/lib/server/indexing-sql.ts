import type { TextChunk } from './semantic-policy';

export type SqlBinding = string | number | null;

export interface SqlCommand {
	readonly sql: string;
	readonly bindings: ReadonlyArray<SqlBinding>;
}

export interface IndexLease {
	readonly fileId: string;
	readonly version: number;
	readonly attempt: number;
	readonly token: string;
}

interface IndexFailure {
	readonly state: 'pending' | 'failed';
	readonly error: string;
	readonly nextRunAt: string | null;
}

const leaseExists = `SELECT 1 FROM files
	WHERE id = ? AND current_version = ?
		AND index_state = 'running' AND index_lease_token = ?`;

const leaseBindings = (lease: IndexLease) => [
	lease.fileId,
	lease.version,
	lease.token
];

const vectorIdsJson = (vectorIds: ReadonlyArray<string>) =>
	JSON.stringify(vectorIds);

export const claimIndexCommand = (
	lease: IndexLease,
	now: string,
	leaseUntil: string,
	maxAttempts: number
): SqlCommand => ({
	sql: `UPDATE files
		SET index_state = 'running', index_attempts = index_attempts + 1,
			index_error = NULL, index_next_run_at = ?, index_lease_token = ?
		WHERE id = ? AND current_version = ? AND deleted_at IS NULL
			AND (expires_at IS NULL OR expires_at > ?)
			AND index_attempts = ? AND index_attempts < ?
			AND (
				index_state IN ('pending', 'disabled')
				OR (index_state = 'running' AND index_next_run_at <= ?)
			)`,
	bindings: [
		leaseUntil,
		lease.token,
		lease.fileId,
		lease.version,
		now,
		lease.attempt - 1,
		maxAttempts,
		now
	]
});

export const extractedTextCommands = (
	lease: IndexLease,
	text: string
): ReadonlyArray<SqlCommand> => [
	{
		sql: `UPDATE file_versions SET text_content = ?
			WHERE file_id = ? AND version = ?
				AND EXISTS (${leaseExists})`,
		bindings: [text, lease.fileId, lease.version, ...leaseBindings(lease)]
	},
	{
		sql: `UPDATE files SET index_cursor = 1
			WHERE id = ? AND current_version = ?
				AND index_state = 'running' AND index_lease_token = ?`,
		bindings: leaseBindings(lease)
	},
	{
		sql: `DELETE FROM files_fts
			WHERE file_id = ? AND EXISTS (${leaseExists})`,
		bindings: [lease.fileId, ...leaseBindings(lease)]
	},
	{
		sql: `INSERT INTO files_fts (name, tags, body, file_id, chunk_no)
			SELECT
				f.display_name,
				COALESCE((
					SELECT group_concat(t.name, ' ')
					FROM file_tags ft
					JOIN tags t ON t.id = ft.tag_id
					WHERE ft.file_id = f.id
				), ''),
				substr(COALESCE(v.text_content, ''), 1, 65536),
				f.id,
				0
			FROM files f
			JOIN file_versions v
				ON v.file_id = f.id AND v.version = f.current_version
			WHERE f.id = ? AND f.current_version = ?
				AND f.index_state = 'running' AND f.index_lease_token = ?`,
		bindings: leaseBindings(lease)
	},
	{
		sql: `DELETE FROM files_trgm
			WHERE file_id = ? AND EXISTS (${leaseExists})`,
		bindings: [lease.fileId, ...leaseBindings(lease)]
	},
	{
		sql: `INSERT INTO files_trgm (name, file_id)
			SELECT display_name, id
			FROM files
			WHERE id = ? AND current_version = ?
				AND index_state = 'running' AND index_lease_token = ?`,
		bindings: leaseBindings(lease)
	}
];

export const finishKeywordOnlyCommand = (lease: IndexLease): SqlCommand => ({
	sql: `UPDATE files
		SET index_state = 'disabled', indexed_version = NULL,
			index_attempts = 0, index_error = NULL,
			index_next_run_at = NULL, index_lease_token = NULL
		WHERE id = ? AND current_version = ?
			AND index_state = 'running' AND index_lease_token = ?`,
	bindings: leaseBindings(lease)
});

const chunkJson = (
	chunks: ReadonlyArray<TextChunk>,
	vectorIds: ReadonlyArray<string>
) =>
	JSON.stringify(
		chunks.map((chunk, index) => ({
			vectorId: vectorIds[index],
			ordinal: chunk.ordinal,
			charStart: chunk.charStart,
			charEnd: chunk.charEnd
		}))
	);

const queueStaleVectorsCommand = (
	lease: IndexLease,
	vectorIds: ReadonlyArray<string>,
	queuedAt: string
): SqlCommand => ({
	sql: `INSERT INTO pending_vector_deletes (vector_id, queued_at)
		SELECT CAST(value AS TEXT), ?
		FROM json_each(?)
		WHERE NOT EXISTS (${leaseExists})
		ON CONFLICT(vector_id) DO NOTHING`,
	bindings: [queuedAt, vectorIdsJson(vectorIds), ...leaseBindings(lease)]
});

const queueAttemptVectorsCommand = (
	vectorIds: ReadonlyArray<string>,
	queuedAt: string
): SqlCommand => ({
	sql: `INSERT INTO pending_vector_deletes (vector_id, queued_at)
		SELECT CAST(value AS TEXT), ? FROM json_each(?) WHERE 1
		ON CONFLICT(vector_id) DO NOTHING`,
	bindings: [queuedAt, vectorIdsJson(vectorIds)]
});

export const semanticCommitCommands = (
	lease: IndexLease,
	chunks: ReadonlyArray<TextChunk>,
	vectorIds: ReadonlyArray<string>,
	indexedAt: string
): ReadonlyArray<SqlCommand> => [
	queueStaleVectorsCommand(lease, vectorIds, indexedAt),
	{
		sql: `INSERT INTO pending_vector_deletes (vector_id, queued_at)
			SELECT chunks.vector_id, ?
			FROM file_chunks chunks
			WHERE chunks.file_id = ?
				AND EXISTS (${leaseExists})
			ON CONFLICT(vector_id) DO NOTHING`,
		bindings: [indexedAt, lease.fileId, ...leaseBindings(lease)]
	},
	{
		sql: `DELETE FROM file_chunks
			WHERE file_id = ? AND EXISTS (${leaseExists})`,
		bindings: [lease.fileId, ...leaseBindings(lease)]
	},
	{
		sql: `INSERT INTO file_chunks (
				vector_id, file_id, version, ordinal, char_start, char_end
			)
			SELECT
				CAST(json_extract(value, '$.vectorId') AS TEXT),
				?,
				?,
				CAST(json_extract(value, '$.ordinal') AS INTEGER),
				CAST(json_extract(value, '$.charStart') AS INTEGER),
				CAST(json_extract(value, '$.charEnd') AS INTEGER)
			FROM json_each(?)
			WHERE EXISTS (${leaseExists})`,
		bindings: [
			lease.fileId,
			lease.version,
			chunkJson(chunks, vectorIds),
			...leaseBindings(lease)
		]
	},
	{
		sql: `UPDATE files
			SET index_state = 'ready', indexed_version = ?, index_cursor = ?,
				index_attempts = 0, index_error = NULL, index_next_run_at = NULL,
				index_lease_token = NULL
			WHERE id = ? AND current_version = ?
				AND index_state = 'running' AND index_lease_token = ?`,
		bindings: [lease.version, chunks.length, ...leaseBindings(lease)]
	}
];

export const indexFailureCommands = (
	lease: IndexLease,
	vectorIds: ReadonlyArray<string>,
	failure: IndexFailure,
	failedAt: string
): ReadonlyArray<SqlCommand> => [
	...(vectorIds.length === 0
		? []
		: [queueAttemptVectorsCommand(vectorIds, failedAt)]),
	{
		sql: `UPDATE files
			SET index_state = ?, index_error = ?, index_next_run_at = ?,
				index_lease_token = NULL
			WHERE id = ? AND current_version = ?
				AND index_state = 'running' AND index_lease_token = ?`,
		bindings: [
			failure.state,
			failure.error,
			failure.nextRunAt,
			...leaseBindings(lease)
		]
	}
];

export const vectorDeleteFailureCommand = (
	rows: ReadonlyArray<{
		readonly vectorId: string;
		readonly nextRunAt: string;
	}>,
	error: string
): SqlCommand => ({
	sql: `UPDATE pending_vector_deletes
		SET attempts = attempts + 1,
			last_error = ?,
			next_run_at = (
				SELECT json_extract(value, '$.nextRunAt')
				FROM json_each(?)
				WHERE json_extract(value, '$.vectorId') =
					pending_vector_deletes.vector_id
			)
		WHERE vector_id IN (
			SELECT json_extract(value, '$.vectorId') FROM json_each(?)
		)`,
	bindings: [error, JSON.stringify(rows), JSON.stringify(rows)]
});

export const vectorDeleteSuccessCommand = (
	vectorIds: ReadonlyArray<string>
): SqlCommand => ({
	sql: `DELETE FROM pending_vector_deletes
		WHERE vector_id IN (SELECT CAST(value AS TEXT) FROM json_each(?))`,
	bindings: [vectorIdsJson(vectorIds)]
});
