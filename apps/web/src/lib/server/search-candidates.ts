import type { PgClient } from '@effect/sql-pg';
import { Effect } from 'effect';

// Candidate pool for one ranking pass. Search pages 50 at a time out of
// this list; keep it large enough for a few pages without scanning the
// whole index.
export const SEARCH_CANDIDATE_LIMIT = 200;

// word_similarity scores how well the query matches any substring of the
// name, so a typo ("reprot") still finds "Quarterly report.pdf". Apply the
// cutoff transaction-locally so the index operator uses the same threshold.
export const TRIGRAM_THRESHOLD = 0.3;

export interface RankedRow {
	readonly file_id: string;
	readonly score: number;
}

export interface CandidateFilter {
	readonly orgId: string;
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
	sql`f.org_id = ${filter.orgId}
		AND f.deleted_at IS NULL
		AND (f.expires_at IS NULL OR f.expires_at > ${filter.now})
		${selectedTagFilter(sql, filter.tagIds)}`;

// Every field has English lexemes, so one native websearch query preserves
// phrase/OR/NOT semantics across metadata and body. Literal metadata lexemes
// also support identifiers consisting entirely of stopwords (such as "the").
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
			SELECT CASE WHEN numnode(english_query) = 0
				THEN websearch_to_tsquery('simple', ${query})
				ELSE english_query END AS query
			FROM (SELECT websearch_to_tsquery('english', ${query}) AS english_query) parsed
		) q
		WHERE d.org_id = ${filter.orgId}
			AND d.tsv @@ q.query
			AND ${visibleFile(sql, filter)}
		GROUP BY d.file_id
		ORDER BY score DESC, d.file_id
		LIMIT ${SEARCH_CANDIDATE_LIMIT}`;

export const trigramCandidates = (
	sql: PgClient.PgClient,
	query: string,
	filter: CandidateFilter
) =>
	sql.withTransaction(
		sql`SELECT set_config('pg_trgm.word_similarity_threshold', ${String(TRIGRAM_THRESHOLD)}, true)`.pipe(
			Effect.andThen(sql<RankedRow>`
				SELECT d.file_id, word_similarity(${query}, d.name) AS score
				FROM search_documents d
				JOIN files f ON f.id = d.file_id
				WHERE d.org_id = ${filter.orgId}
					AND d.chunk_no = 0
					AND d.name %> ${query}
					AND word_similarity(${query}, d.name) > ${TRIGRAM_THRESHOLD}::real
					AND ${visibleFile(sql, filter)}
				ORDER BY score DESC, d.file_id
				LIMIT ${SEARCH_CANDIDATE_LIMIT}`)
		)
	);
