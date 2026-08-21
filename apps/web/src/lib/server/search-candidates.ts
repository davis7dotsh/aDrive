export type SearchIndex = 'files_fts' | 'files_trgm';

// Candidate pool for one ranking pass. Search pages 50 at a time out of
// this list; keep it large enough for a few pages without scanning the
// whole index.
export const SEARCH_CANDIDATE_LIMIT = 200;

export interface SearchCommand {
	readonly sql: string;
	readonly bindings: ReadonlyArray<string>;
}

const selectedTagFilter = (fileAlias: string, tagIds: ReadonlyArray<string>) =>
	tagIds.length === 0
		? ''
		: `AND EXISTS (
			SELECT 1 FROM file_tags selected
			WHERE selected.file_id = ${fileAlias}.id
				AND selected.tag_id IN (${tagIds.map(() => '?').join(', ')})
		)`;

export const rankedSearchCommand = (
	index: SearchIndex,
	match: string,
	now: string,
	tagIds: ReadonlyArray<string>
): SearchCommand => {
	const score =
		index === 'files_fts'
			? 'bm25(files_fts, 10.0, 5.0, 1.0)'
			: 'bm25(files_trgm)';
	return {
		sql: `SELECT ${index}.file_id, ${score} AS score
			FROM ${index}
			JOIN files f ON f.id = ${index}.file_id
			WHERE ${index} MATCH ?
				AND f.deleted_at IS NULL
				AND (f.expires_at IS NULL OR f.expires_at > ?)
				${selectedTagFilter('f', tagIds)}
			ORDER BY score ASC, ${index}.file_id
			LIMIT ${SEARCH_CANDIDATE_LIMIT}`,
		bindings: [match, now, ...tagIds]
	};
};

export const eligibleSemanticCommand = (
	fileIds: ReadonlyArray<string>,
	now: string,
	tagIds: ReadonlyArray<string>
): SearchCommand => ({
	sql: `WITH requested AS (
			SELECT CAST(key AS INTEGER) AS ordinal, CAST(value AS TEXT) AS file_id
			FROM json_each(?)
		)
		SELECT requested.file_id, requested.ordinal
		FROM requested
		JOIN files f ON f.id = requested.file_id
		WHERE f.deleted_at IS NULL
			AND (f.expires_at IS NULL OR f.expires_at > ?)
			${selectedTagFilter('f', tagIds)}
		ORDER BY requested.ordinal
		LIMIT ${SEARCH_CANDIDATE_LIMIT}`,
	bindings: [JSON.stringify(fileIds), now, ...tagIds]
});
