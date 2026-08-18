import type { DashboardFile } from '@adrive/shared';
import { Context, Effect, Layer } from 'effect';
import { StorageError } from '../errors';
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
}

export interface SearchShape {
	readonly files: (
		input: SearchInput
	) => Effect.Effect<ReadonlyArray<DashboardFile>, StorageError>;
}

export class Search extends Context.Service<Search, SearchShape>()(
	'app/Search'
) {}

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
		tagIds: ReadonlyArray<string>
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
						LIMIT 200`
					)
					.bind(new Date().toISOString(), ...tagIds)
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
		files: Effect.fn('Search.files')(function* ({ query, tagIds }) {
			const selectedTagIds = [...new Set(tagIds)].slice(0, 20);
			const trimmedQuery = query.trim().slice(0, 256);
			const keywordMatch = sanitizeMatchQuery(trimmedQuery);
			if (!keywordMatch) return yield* filteredRecent(selectedTagIds);

			const trigramMatch = sanitizeTrigramQuery(trimmedQuery);
			const now = new Date().toISOString();
			const keyword = yield* runRanked(
				rankedSearchCommand('files_fts', keywordMatch, now, selectedTagIds)
			);
			const trigram = trigramMatch
				? yield* runRanked(
						rankedSearchCommand('files_trgm', trigramMatch, now, selectedTagIds)
					)
				: [];
			const semanticCandidates = shouldEmbedSearchQuery(trimmedQuery)
				? yield* embedder.query(trimmedQuery).pipe(
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
				: [];
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
			const fused = reciprocalRankFusion({
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
			});
			const hydrated = yield* hydrate(
				fused.map((file) => file.fileId),
				selectedTagIds
			);
			return pinExactName(trimmedQuery, hydrated);
		})
	});
});

export const SearchLive = Layer.effect(Search, makeSearch);
