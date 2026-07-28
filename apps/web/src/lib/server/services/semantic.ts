import { Context, Effect, Layer } from 'effect';
import { StorageError } from '../errors';
import { collapseVectorMatches } from '../semantic-policy';

const EMBEDDING_MODEL = '@cf/baai/bge-small-en-v1.5';

export interface EmbedderShape {
	readonly enabled: boolean;
	readonly documents: (
		values: ReadonlyArray<string>
	) => Effect.Effect<ReadonlyArray<ReadonlyArray<number>>, StorageError>;
	readonly query: (
		value: string
	) => Effect.Effect<ReadonlyArray<number> | null, StorageError>;
}

export interface VectorRecord {
	readonly id: string;
	readonly values: ReadonlyArray<number>;
	readonly metadata: {
		readonly fileId: string;
		readonly version: number;
		readonly deleted: boolean;
		readonly kind: string;
		readonly visibility: string;
	};
}

export interface VectorIndexShape {
	readonly enabled: boolean;
	readonly upsert: (
		vectors: ReadonlyArray<VectorRecord>
	) => Effect.Effect<void, StorageError>;
	readonly remove: (
		vectorIds: ReadonlyArray<string>
	) => Effect.Effect<void, StorageError>;
	readonly search: (
		vector: ReadonlyArray<number> | null
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
	readonly VECTORIZE: Vectorize;
};

export const hasSemanticBindings = (env: Env): env is SemanticBoundEnv =>
	'AI' in env && 'VECTORIZE' in env;

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
		remove: () => Effect.void,
		search: () => Effect.succeed([]),
		count: Effect.succeed(0)
	})
);

const liveLayers = (env: SemanticBoundEnv) => {
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

	const embedder = Layer.succeed(
		Embedder,
		Embedder.of({
			enabled: true,
			documents: (values) =>
				values.length === 0 ? Effect.succeed([]) : embed(values),
			query: (value) =>
				embed([value]).pipe(Effect.map((vectors) => vectors[0] ?? null))
		})
	);

	const vectorIndex = Layer.succeed(
		VectorIndex,
		VectorIndex.of({
			enabled: true,
			upsert: (vectors) =>
				vectors.length === 0
					? Effect.void
					: Effect.tryPromise({
							try: () =>
								env.VECTORIZE.upsert(
									vectors.map((vector) => ({
										id: vector.id,
										values: [...vector.values],
										metadata: vector.metadata
									}))
								),
							catch: (cause) =>
								new StorageError({
									operation: 'upsert semantic vectors',
									cause
								})
						}).pipe(Effect.asVoid),
			remove: (vectorIds) =>
				vectorIds.length === 0
					? Effect.void
					: Effect.tryPromise({
							try: () => env.VECTORIZE.deleteByIds([...vectorIds]),
							catch: (cause) =>
								new StorageError({
									operation: 'delete semantic vectors',
									cause
								})
						}).pipe(Effect.asVoid),
			search: (vector) =>
				vector === null
					? Effect.succeed([])
					: Effect.tryPromise({
							try: () =>
								env.VECTORIZE.query([...vector], {
									topK: 50,
									returnMetadata: false
								}),
							catch: (cause) =>
								new StorageError({
									operation: 'query semantic vectors',
									cause
								})
						}).pipe(
							Effect.map((result) => collapseVectorMatches(result.matches))
						),
			count: Effect.tryPromise({
				try: async () => (await env.VECTORIZE.describe()).vectorCount,
				catch: (cause) =>
					new StorageError({ operation: 'describe semantic index', cause })
			})
		})
	);

	return Layer.merge(embedder, vectorIndex);
};

export const SemanticBindingsLive = (env: Env) => {
	const mode = String(env.SEMANTIC_SEARCH);
	if (mode === 'off') {
		return Layer.merge(EmbedderNull, VectorIndexNull);
	}
	if (hasSemanticBindings(env)) return liveLayers(env);
	if (mode === 'required') {
		throw new Error(
			'SEMANTIC_SEARCH=required needs both AI and VECTORIZE bindings'
		);
	}
	return Layer.merge(EmbedderNull, VectorIndexNull);
};
