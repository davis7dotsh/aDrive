import type { DashboardFile } from '@adrive/shared';
import { Context, Effect, Layer } from 'effect';
import type { SqlError } from 'effect/unstable/sql/SqlError';
import { InvalidRequest, StorageError } from '../errors';
import {
	dashboardFileColumns,
	decodeDashboardRows,
	toDashboardFile
} from '../file-rows';
import {
	hasSearchableQuery,
	pinExactName,
	reciprocalRankFusion,
	shouldEmbedSearchQuery,
	shouldFuzzyMatchQuery
} from '../search-ranking';
import {
	fullTextCandidates,
	SEARCH_CANDIDATE_LIMIT,
	selectedTagFilter,
	trigramCandidates,
	type RankedRow
} from '../search-candidates';
import { PgSql } from '../pg';
import { Embedder, VectorIndex } from './semantic';

export interface SearchInput {
	readonly query: string;
	readonly tagIds: ReadonlyArray<string>;
	readonly cursor?: string | null;
}

// Search results are a fully ranked list, so pagination is an offset into
// that ranking; the candidate pool itself stays bounded upstream. The
// cursor round-trips as "o:<page>".
const PAGE_SIZE = 50;
const MAX_PAGE = 100;
export interface SearchPage {
	readonly files: ReadonlyArray<DashboardFile>;
	readonly nextCursor: string | null;
}

export interface SearchShape {
	readonly files: (
		input: SearchInput
	) => Effect.Effect<SearchPage, InvalidRequest | StorageError>;
}

export class Search extends Context.Service<Search, SearchShape>()(
	'app/Search'
) {}

const decodeCursor = (cursor: string | null | undefined) => {
	if (!cursor) return 0;
	const match = /^o:(\d+)$/.exec(cursor);
	const page = match ? Number(match[1]) : Number.NaN;
	return Number.isSafeInteger(page) && page >= 0 && page < MAX_PAGE
		? page
		: null;
};

const noCandidates = Effect.succeed<ReadonlyArray<RankedRow>>([]);

const makeSearch = Effect.gen(function* () {
	const sql = yield* PgSql;
	const embedder = yield* Embedder;
	const vectorIndex = yield* VectorIndex;

	const ranked = (
		operation: string,
		candidates: Effect.Effect<ReadonlyArray<RankedRow>, SqlError>
	) =>
		candidates.pipe(
			Effect.mapError((cause) => new StorageError({ operation, cause }))
		);

	const hydrate = Effect.fn('Search.hydrate')(function* (
		fileIds: ReadonlyArray<string>,
		tagIds: ReadonlyArray<string>
	) {
		if (fileIds.length === 0) return [];
		const result = yield* sql`
			SELECT ${sql.literal(dashboardFileColumns)}
			FROM files f
			WHERE ${sql.in('f.id', fileIds)}
				AND f.deleted_at IS NULL
				AND (f.expires_at IS NULL OR f.expires_at > ${new Date().toISOString()})
				${selectedTagFilter(sql, tagIds)}`.pipe(
			Effect.mapError(
				(cause) =>
					new StorageError({ operation: 'hydrate search results', cause })
			)
		);
		const byId = new Map(
			decodeDashboardRows(result)
				.map(toDashboardFile)
				.map((file) => [file.id, file])
		);
		return fileIds.flatMap((id) => {
			const file = byId.get(id);
			return file ? [file] : [];
		});
	});

	const filteredRecent = Effect.fn('Search.filteredRecent')(function* (
		tagIds: ReadonlyArray<string>,
		limit: number,
		offset: number
	) {
		const rows = yield* sql`
			SELECT ${sql.literal(dashboardFileColumns)}
			FROM files f
			WHERE f.deleted_at IS NULL
				AND (f.expires_at IS NULL OR f.expires_at > ${new Date().toISOString()})
				${selectedTagFilter(sql, tagIds)}
			ORDER BY f.updated_at DESC, f.id
			LIMIT ${limit} OFFSET ${offset}`.pipe(
			Effect.mapError(
				(cause) => new StorageError({ operation: 'list filtered files', cause })
			)
		);
		return decodeDashboardRows(rows).map(toDashboardFile);
	});

	return Search.of({
		files: Effect.fn('Search.files')(function* ({ query, tagIds, cursor }) {
			const page = decodeCursor(cursor ?? null);
			if (page === null) {
				return yield* new InvalidRequest({
					status: 400,
					message: 'Search cursor is invalid'
				});
			}
			const offset = page * PAGE_SIZE;
			const selectedTagIds = [...new Set(tagIds)].slice(0, 20);
			const trimmedQuery = query.trim().slice(0, 256);
			if (!hasSearchableQuery(trimmedQuery)) {
				const recent = yield* filteredRecent(
					selectedTagIds,
					PAGE_SIZE + 1,
					offset
				);
				return {
					files: recent.slice(0, PAGE_SIZE),
					nextCursor:
						recent.length > PAGE_SIZE && page + 1 < MAX_PAGE
							? `o:${page + 1}`
							: null
				};
			}

			const filter = { now: new Date().toISOString(), tagIds: selectedTagIds };
			// The index reads (full text, trigram) and the optional embedding +
			// vector query are independent; run them concurrently so search
			// latency is the slowest source, not their sum. Workers AI
			// embeddings are usually the slowest leg, so they start now. The
			// vector query filters visibility and tags itself, so its rows
			// go straight into fusion.
			const [keyword, trigram, semantic] = yield* Effect.all(
				[
					ranked(
						'keyword search',
						fullTextCandidates(sql, trimmedQuery, filter)
					),
					shouldFuzzyMatchQuery(trimmedQuery)
						? ranked(
								'trigram search',
								trigramCandidates(sql, trimmedQuery, filter)
							)
						: noCandidates,
					shouldEmbedSearchQuery(trimmedQuery)
						? embedder.query(trimmedQuery).pipe(
								Effect.flatMap((embedding) =>
									vectorIndex.search(embedding, filter)
								),
								Effect.catch((failure) =>
									Effect.sync(() => {
										console.error(
											JSON.stringify({
												message: 'semantic search degraded to keyword search',
												operation: failure.operation
											})
										);
										return [];
									})
								)
							)
						: Effect.succeed<ReadonlyArray<{ fileId: string }>>([])
				],
				{ concurrency: 'unbounded' }
			);
			// Fuse the full candidate pool on every page so page 0 and
			// page 1 slice the same ranking instead of two different
			// prefixes (offset+51 vs offset+101).
			const fused = reciprocalRankFusion(
				{
					keyword: {
						results: keyword.map((row) => ({ fileId: row.file_id })),
						weight: 1
					},
					trigram: {
						results: trigram.map((row) => ({ fileId: row.file_id })),
						weight: 0.5
					},
					semantic: {
						results: semantic,
						weight: 1
					}
				},
				SEARCH_CANDIDATE_LIMIT
			);
			const visible = fused.slice(offset, offset + PAGE_SIZE);
			const hydrated = yield* hydrate(
				visible.map((entry) => entry.fileId),
				selectedTagIds
			);
			return {
				files: pinExactName(trimmedQuery, hydrated),
				nextCursor:
					offset + PAGE_SIZE < fused.length && page + 1 < MAX_PAGE
						? `o:${page + 1}`
						: null
			};
		})
	});
});

export const SearchLive = Layer.effect(Search, makeSearch);
