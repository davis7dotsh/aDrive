import { Context, Effect, Layer } from 'effect';
import { StorageError } from '../errors';
import { upsertFileChunks, type VectorChunk } from '../indexing-sql';
import { PgSql } from '../pg';
import { createQueryEmbeddingCache } from '../query-embedding-cache';
import { selectedTagFilter, type CandidateFilter } from '../search-candidates';
import { CHUNK_CHARACTERS, CHUNK_OVERLAP_CHARACTERS } from '../semantic-policy';
import { searchTextLimit } from '../search-text';

const EMBEDDING_MODEL = '@cf/baai/bge-small-en-v1.5';
// Vector candidates feed reciprocal rank fusion beside the keyword pool;
// one hundred nearest files is plenty for a few result pages.
const SEMANTIC_CANDIDATE_LIMIT = 100;
// Reserve enough chunk candidates for 100 distinct files even when each
// nearer file has the maximum number produced by chunkSearchText.
const SEMANTIC_CHUNK_LIMIT =
	SEMANTIC_CANDIDATE_LIMIT *
	Math.ceil(searchTextLimit / (CHUNK_CHARACTERS - CHUNK_OVERLAP_CHARACTERS));

export interface EmbedderShape {
	readonly enabled: boolean;
	readonly documents: (
		values: ReadonlyArray<string>
	) => Effect.Effect<ReadonlyArray<ReadonlyArray<number>>, StorageError>;
	readonly query: (
		value: string
	) => Effect.Effect<ReadonlyArray<number> | null, StorageError>;
}

export interface VectorIndexShape {
	readonly enabled: boolean;
	readonly upsert: (
		rows: ReadonlyArray<VectorChunk>
	) => Effect.Effect<void, StorageError>;
	readonly search: (
		vector: ReadonlyArray<number> | null,
		filter: CandidateFilter
	) => Effect.Effect<ReadonlyArray<{ readonly fileId: string }>, StorageError>;
	readonly count: Effect.Effect<number, StorageError>;
}

export class Embedder extends Context.Service<Embedder, EmbedderShape>()(
	'app/Embedder'
) {}

export class VectorIndex extends Context.Service<
	VectorIndex,
	VectorIndexShape
>()('app/VectorIndex') {}

type SemanticBoundEnv = Env & {
	readonly AI: Ai;
};

// Vectors live in Postgres, which every request has, so the only optional
// binding left is Workers AI for the embeddings themselves.
export const hasSemanticBindings = (env: Env): env is SemanticBoundEnv =>
	'AI' in env && env.AI !== undefined;

const embeddingData = (response: Ai_Cf_Baai_Bge_Small_En_V1_5_Output) => {
	if (
		!('data' in response) ||
		!Array.isArray(response.data) ||
		!Array.isArray(response.shape) ||
		response.shape.at(-1) !== 384 ||
		(response.pooling !== undefined && response.pooling !== 'cls') ||
		response.data.some(
			(vector) =>
				!Array.isArray(vector) ||
				vector.length !== response.shape?.at(-1) ||
				vector.some((value) => !Number.isFinite(value))
		)
	) {
		throw new Error('Workers AI returned invalid 384-dimension embeddings');
	}
	return response.data;
};

export const EmbedderNull = Layer.succeed(
	Embedder,
	Embedder.of({
		enabled: false,
		documents: () => Effect.succeed([]),
		query: () => Effect.succeed(null)
	})
);

export const VectorIndexNull = Layer.succeed(
	VectorIndex,
	VectorIndex.of({
		enabled: false,
		upsert: () => Effect.void,
		search: () => Effect.succeed([]),
		count: Effect.succeed(0)
	})
);

// pgvector reads the same bracketed text form it prints, so the query
// vector travels as one bound parameter cast on the server.
export const vectorLiteral = (vector: ReadonlyArray<number>) =>
	`[${vector.join(',')}]`;

export const makeVectorIndex = (
	sql: PgSql['Service'],
	enabled: boolean
): VectorIndexShape => ({
	enabled,
	upsert: (rows) =>
		upsertFileChunks(sql, rows).pipe(
			Effect.mapError(
				(cause) =>
					new StorageError({ operation: 'upsert semantic vectors', cause })
			)
		),
	// The nearest chunk stands in for its file, and visibility and tags
	// are filtered here so the caller never sees a file it cannot open.
	// pgvector >= 0.8 iterative scans continue past filtered-out neighbors;
	// the chunk limit is applied before grouping so HNSW can serve the sort.
	search: (vector, filter) =>
		vector === null
			? Effect.succeed([])
			: sql
					.withTransaction(
						sql`SET LOCAL hnsw.iterative_scan = strict_order`.pipe(
							Effect.andThen(sql<{ file_id: string }>`
							WITH nearest_chunks AS MATERIALIZED (
								SELECT c.file_id, c.embedding <=> ${vectorLiteral(vector)}::vector AS distance
								FROM file_chunks c
								JOIN files f ON f.id = c.file_id AND f.current_version = c.version
								WHERE c.embedding IS NOT NULL
									AND f.deleted_at IS NULL
									AND (f.expires_at IS NULL OR f.expires_at > ${filter.now})
									${selectedTagFilter(sql, filter.tagIds)}
								ORDER BY c.embedding <=> ${vectorLiteral(vector)}::vector
								LIMIT ${SEMANTIC_CHUNK_LIMIT}
							)
							SELECT file_id FROM nearest_chunks
							GROUP BY file_id
							ORDER BY MIN(distance), file_id
							LIMIT ${SEMANTIC_CANDIDATE_LIMIT}`)
						)
					)
					.pipe(
						Effect.map((rows) => rows.map((row) => ({ fileId: row.file_id }))),
						Effect.mapError(
							(cause) =>
								new StorageError({ operation: 'query semantic vectors', cause })
						)
					),
	count: sql<{ count: number }>`
		SELECT COUNT(*)::integer AS count FROM file_chunks WHERE embedding IS NOT NULL`.pipe(
		Effect.map((rows) => rows[0]?.count ?? 0),
		Effect.mapError(
			(cause) =>
				new StorageError({ operation: 'count semantic vectors', cause })
		)
	)
});

export const VectorIndexLive = (enabled: boolean) =>
	Layer.effect(
		VectorIndex,
		Effect.map(PgSql, (sql) => makeVectorIndex(sql, enabled))
	);

const embedderLive = (env: SemanticBoundEnv) => {
	const embeddings = createQueryEmbeddingCache(env.AUTH_GUARD);
	const embed = (values: ReadonlyArray<string>) =>
		Effect.tryPromise({
			try: async () =>
				embeddingData(
					await env.AI.run(EMBEDDING_MODEL, {
						text: [...values],
						pooling: 'cls'
					})
				),
			catch: (cause) =>
				new StorageError({ operation: 'generate embeddings', cause })
		});

	return Layer.succeed(
		Embedder,
		Embedder.of({
			enabled: true,
			documents: (values) =>
				values.length === 0 ? Effect.succeed([]) : embed(values),
			query: (value) =>
				Effect.gen(function* () {
					const cached = yield* Effect.promise(() => embeddings.get(value));
					if (cached) return cached;
					const vector = yield* embed([value]).pipe(
						Effect.map((vectors) => vectors[0] ?? null)
					);
					if (vector) {
						yield* Effect.promise(() => embeddings.set(value, vector));
					}
					return vector;
				})
		})
	);
};

export const SemanticBindingsLive = (env: Env) => {
	const mode = String(env.SEMANTIC_SEARCH);
	if (mode === 'off') {
		return Layer.merge(EmbedderNull, VectorIndexLive(false));
	}
	if (hasSemanticBindings(env)) {
		return Layer.merge(embedderLive(env), VectorIndexLive(true));
	}
	if (mode === 'required') {
		throw new Error('SEMANTIC_SEARCH=required needs the AI binding');
	}
	return Layer.merge(EmbedderNull, VectorIndexLive(false));
};
