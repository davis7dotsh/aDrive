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
	sanitizeTrigramQuery
} from '../search-ranking';
import { Db } from './bindings';

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

	const runRanked = (
		statement: D1PreparedStatement
	): Effect.Effect<ReadonlyArray<RankedRow>, StorageError> =>
		Effect.tryPromise({
			try: async () => {
				const result = await statement.all<RankedRow>();
				if (!result.success) throw new Error(result.error ?? 'Search failed');
				return result.results;
			},
			catch: (cause) => new StorageError({ operation: 'search index', cause })
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
			const keyword = yield* runRanked(
				db
					.prepare(
						`SELECT file_id, bm25(files_fts, 10.0, 5.0, 1.0) AS score
						FROM files_fts
						WHERE files_fts MATCH ?
						ORDER BY score ASC, file_id
						LIMIT 50`
					)
					.bind(keywordMatch)
			);
			const trigram = trigramMatch
				? yield* runRanked(
						db
							.prepare(
								`SELECT file_id, bm25(files_trgm) AS score
								FROM files_trgm
								WHERE files_trgm MATCH ?
								ORDER BY score ASC, file_id
								LIMIT 50`
							)
							.bind(trigramMatch)
					)
				: [];
			const fused = reciprocalRankFusion({
				keyword: {
					results: keyword.map((row) => ({ fileId: row.file_id })),
					weight: 1
				},
				trigram: {
					results: trigram.map((row) => ({ fileId: row.file_id })),
					weight: 0.5
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
