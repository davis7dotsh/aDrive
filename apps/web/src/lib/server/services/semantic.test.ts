import { Effect, Layer } from 'effect';
import { describe, expect, it } from 'vitest';
import {
	Embedder,
	EmbedderNull,
	VectorIndex,
	VectorIndexNull
} from './semantic';

describe('semantic null-object layers', () => {
	it('keep document and query operations harmless without bindings', async () => {
		const result = await Effect.runPromise(
			Effect.gen(function* () {
				const embedder = yield* Embedder;
				const vectors = yield* VectorIndex;
				return {
					enabled: embedder.enabled && vectors.enabled,
					documents: yield* embedder.documents(['hello']),
					query: yield* embedder.query('hello'),
					search: yield* vectors.search(null),
					count: yield* vectors.count
				};
			}).pipe(Effect.provide(Layer.merge(EmbedderNull, VectorIndexNull)))
		);
		expect(result).toEqual({
			enabled: false,
			documents: [],
			query: null,
			search: [],
			count: 0
		});
	});
});
