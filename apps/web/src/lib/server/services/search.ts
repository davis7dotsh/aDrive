import type { DashboardFile } from '@adrive/shared';
import { Context, Effect, Layer } from 'effect';
import { InvalidRequest, StorageError } from '../errors';
import {
	dashboardFileColumns,
	decodeDashboardRows,
	toDashboardFile
} from '../file-rows';
import {
	pinExactName,
	reciprocalRankFusion,
	sanitizeMatchQuery,
	sanitizeTrigramQuery,
	shouldEmbedSearchQuery
} from '../search-ranking';
import {
	eligibleSemanticCommand,
	rankedSearchCommand,
	SEARCH_CANDIDATE_LIMIT,
	type SearchCommand
} from '../search-candidates';
import { Db } from './bindings';
import { Embedder, VectorIndex } from './semantic';

interface RankedRow {
	readonly file_id: string;
	readonly score: number;
}

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

const makeSearch = Effect.gen(function* () {
	const db = yield* Db;
	const embedder = yield* Embedder;
	const vectorIndex = yield* VectorIndex;

	const runRanked = (
		command: SearchCommand
	): Effect.Effect<ReadonlyArray<RankedRow>, StorageError> =>
		Effect.tryPromise({
			try: async () => {
				const result = await db
					.prepare(command.sql)
					.bind(...command.bindings)
					.all<RankedRow>();
				if (!result.success) throw new Error(result.error ?? 'Search failed');
				return result.results;
			},
			catch: (cause) => new StorageError({ operation: 'search index', cause })
		});

	const filterSemantic = Effect.fn('Search.filterSemantic')(function* (
		fileIds: ReadonlyArray<string>,
		tagIds: ReadonlyArray<string>,
		now: string
	) {
		if (fileIds.length === 0) return [];
		const command = eligibleSemanticCommand(fileIds, now, tagIds);
		return yield* Effect.tryPromise({
			try: async () => {
				const result = await db
					.prepare(command.sql)
					.bind(...command.bindings)
					.all<{ file_id: string; ordinal: number }>();
				if (!result.success)
					throw new Error(result.error ?? 'Semantic filtering failed');
				return result.results.map((row) => ({ fileId: row.file_id }));
			},
			catch: (cause) =>
				new StorageError({
					operation: 'filter semantic search candidates',
					cause
				})
		});
	});

	const hydrate = Effect.fn('Search.hydrate')(function* (
		fileIds: ReadonlyArray<string>,
		tagIds: ReadonlyArray<string>
	) {
		if (fileIds.length === 0) return [];
		const idPlaceholders = fileIds.map(() => '?').join(', ');
		const tagFilter =
			tagIds.length === 0
				? ''
				: `AND EXISTS (
					SELECT 1 FROM file_tags selected
					WHERE selected.file_id = f.id
						AND selected.tag_id IN (${tagIds.map(() => '?').join(', ')})
				)`;
		const result = yield* Effect.tryPromise({
			try: async () => {
				const response = await db
					.prepare(
						`SELECT ${dashboardFileColumns}
						FROM files f
						WHERE f.id IN (${idPlaceholders})
							AND f.deleted_at IS NULL
							AND (f.expires_at IS NULL OR f.expires_at > ?)
							${tagFilter}`
					)
					.bind(...fileIds, new Date().toISOString(), ...tagIds)
					.all();
				if (!response.success)
					throw new Error(response.error ?? 'Hydration failed');
				return response.results;
			},
			catch: (cause) =>
				new StorageError({ operation: 'hydrate search results', cause })
		});
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
		const tagFilter =
			tagIds.length === 0
				? ''
				: `AND EXISTS (
					SELECT 1 FROM file_tags selected
					WHERE selected.file_id = f.id
						AND selected.tag_id IN (${tagIds.map(() => '?').join(', ')})
				)`;
		const rows = yield* Effect.tryPromise({
			try: async () => {
				const response = await db
					.prepare(
						`SELECT ${dashboardFileColumns}
						FROM files f
						WHERE f.deleted_at IS NULL
							AND (f.expires_at IS NULL OR f.expires_at > ?)
							${tagFilter}
						ORDER BY f.updated_at DESC, f.id
						LIMIT ? OFFSET ?`
					)
					.bind(new Date().toISOString(), ...tagIds, limit, offset)
					.all();
				if (!response.success)
					throw new Error(response.error ?? 'File listing failed');
				return response.results;
			},
			catch: (cause) =>
				new StorageError({ operation: 'list filtered files', cause })
		});
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
			const keywordMatch = sanitizeMatchQuery(trimmedQuery);
			if (!keywordMatch) {
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

			const trigramMatch = sanitizeTrigramQuery(trimmedQuery);
			const now = new Date().toISOString();
			// The index reads (FTS, trigram) and the optional embedding +
			// vector query are independent; run them concurrently so search
			// latency is the slowest source, not their sum. Workers AI
			// embeddings are usually the slowest leg, so they start now.
			const [keyword, trigram, semanticCandidates] = yield* Effect.all(
				[
					runRanked(
						rankedSearchCommand('files_fts', keywordMatch, now, selectedTagIds)
					),
					trigramMatch
						? runRanked(
								rankedSearchCommand(
									'files_trgm',
									trigramMatch,
									now,
									selectedTagIds
								)
							)
						: Effect.succeed<ReadonlyArray<RankedRow>>([]),
					shouldEmbedSearchQuery(trimmedQuery)
						? embedder.query(trimmedQuery).pipe(
								Effect.flatMap((embedding) => vectorIndex.search(embedding)),
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
			const semantic = yield* filterSemantic(
				semanticCandidates.map((candidate) => candidate.fileId),
				selectedTagIds,
				now
			).pipe(
				Effect.catch((failure) =>
					Effect.sync(() => {
						console.error(
							JSON.stringify({
								message:
									'semantic candidate filtering degraded to keyword search',
								operation: failure.operation
							})
						);
						return [];
					})
				)
			);
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
				Math.min(offset + PAGE_SIZE + 1, SEARCH_CANDIDATE_LIMIT)
			);
			// Hydrate only the visible page. The extra fused row decides
			// nextCursor so pinExactName cannot steal from the lookahead.
			const visible = fused.slice(offset, offset + PAGE_SIZE);
			const hydrated = yield* hydrate(
				visible.map((entry) => entry.fileId),
				selectedTagIds
			);
			return {
				files: pinExactName(trimmedQuery, hydrated),
				nextCursor:
					fused.length > offset + PAGE_SIZE && page + 1 < MAX_PAGE
						? `o:${page + 1}`
						: null
			};
		})
	});
});

export const SearchLive = Layer.effect(Search, makeSearch);
