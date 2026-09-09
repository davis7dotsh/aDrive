import type { PgClient } from '@effect/sql-pg';

// Candidate pool for one ranking pass. Search pages 50 at a time out of
// this list; keep it large enough for a few pages without scanning the
// whole index.
export const SEARCH_CANDIDATE_LIMIT = 200;

// word_similarity scores how well the query matches any substring of the
// name, so a typo ("reprot") still finds "Quarterly report.pdf". Kept in
// code rather than pg_trgm's session threshold so the cutoff is explicit.
export const TRIGRAM_THRESHOLD = 0.3;

export interface RankedRow {
	readonly file_id: string;
	readonly score: number;
}

export interface CandidateFilter {
	readonly now: string;
	readonly tagIds: ReadonlyArray<string>;
}

export const selectedTagFilter = (
	sql: PgClient.PgClient,
	tagIds: ReadonlyArray<string>
) =>
	tagIds.length === 0
		? sql``
		: sql`AND EXISTS (
			SELECT 1 FROM file_tags selected
			WHERE selected.file_id = f.id
				AND selected.tag_id = ANY(${tagIds}::text[])
		)`;

const visibleFile = (sql: PgClient.PgClient, filter: CandidateFilter) =>
	sql`f.deleted_at IS NULL
		AND (f.expires_at IS NULL OR f.expires_at > ${filter.now})
		${selectedTagFilter(sql, filter.tagIds)}`;

// Names and tags are indexed with the `simple` dictionary and bodies with
// `english`, so the query is parsed both ways and OR-ed: "Quarterly" must
// match the name token `quarterly` and the body stem `quarter`.
export const fullTextCandidates = (
	sql: PgClient.PgClient,
	query: string,
	filter: CandidateFilter
) =>
	sql<RankedRow>`
		SELECT d.file_id, MAX(ts_rank_cd('{0.1, 0.2, 0.4, 1.0}', d.tsv, q.query)) AS score
		FROM search_documents d
		JOIN files f ON f.id = d.file_id
		CROSS JOIN (
			SELECT websearch_to_tsquery('simple', ${query})
				|| websearch_to_tsquery('english', ${query}) AS query
		) q
		WHERE d.tsv @@ q.query
			AND ${visibleFile(sql, filter)}
		GROUP BY d.file_id
		ORDER BY score DESC, d.file_id
		LIMIT ${SEARCH_CANDIDATE_LIMIT}`;

export const trigramCandidates = (
	sql: PgClient.PgClient,
	query: string,
	filter: CandidateFilter
) =>
	sql<RankedRow>`
		SELECT d.file_id, word_similarity(${query}, d.name) AS score
		FROM search_documents d
		JOIN files f ON f.id = d.file_id
		WHERE d.chunk_no = 0
			AND word_similarity(${query}, d.name) > ${TRIGRAM_THRESHOLD}::real
			AND ${visibleFile(sql, filter)}
		ORDER BY score DESC, d.file_id
		LIMIT ${SEARCH_CANDIDATE_LIMIT}`;
