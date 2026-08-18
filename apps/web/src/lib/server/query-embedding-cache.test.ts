import { describe, expect, it, vi } from 'vitest';
import {
	QUERY_EMBED_KV_PREFIX,
	QUERY_EMBED_KV_TTL_SECONDS,
	QueryEmbeddingCache,
	normalizeQueryForEmbed,
	parseStoredEmbedding
} from './query-embedding-cache';

const vector = Array.from({ length: 384 }, (_, index) => index / 384);

describe('query embedding cache', () => {
	it('normalizes queries and rejects stored vectors that are the wrong shape', () => {
		expect(normalizeQueryForEmbed('  Orbit  ')).toBe('Orbit');
		expect(parseStoredEmbedding(null)).toBeNull();
		expect(parseStoredEmbedding('[1,2]')).toBeNull();
		expect(parseStoredEmbedding(JSON.stringify(vector))).toEqual(vector);
	});

	it('returns isolate-memory hits without reading KV', async () => {
		const store = {
			get: vi.fn(async () => null),
			put: vi.fn(async () => {}),
			delete: vi.fn(async () => {})
		};
		const cache = new QueryEmbeddingCache(store, new Map());
		cache.setMemory('orbit', vector);
		await expect(cache.get('  orbit  ')).resolves.toEqual(vector);
		expect(store.get).not.toHaveBeenCalled();
	});

	it('hydrates memory from KV and writes both layers on store', async () => {
		const values = new Map<string, string>();
		const store = {
			get: async (key: string) => values.get(key) ?? null,
			put: async (
				key: string,
				value: string,
				options: { readonly expirationTtl: number }
			) => {
				expect(options.expirationTtl).toBe(QUERY_EMBED_KV_TTL_SECONDS);
				values.set(key, value);
			},
			delete: async (key: string) => {
				values.delete(key);
			}
		};
		const cache = new QueryEmbeddingCache(store, new Map());
		await cache.set('manifest', vector);
		const key = await cache.digestKey('manifest');
		expect(key.startsWith(QUERY_EMBED_KV_PREFIX)).toBe(true);
		expect(values.get(key)).toBe(JSON.stringify(vector));

		const cold = new QueryEmbeddingCache(store, new Map());
		await expect(cold.get('manifest')).resolves.toEqual(vector);
		expect(cold.getMemory('manifest')).toEqual(vector);
	});

	it('survives KV failures and still serves from memory', async () => {
		const cache = new QueryEmbeddingCache(
			{
				get: async () => {
					throw new Error('kv unavailable');
				},
				put: async () => {
					throw new Error('kv unavailable');
				},
				delete: async () => {}
			},
			new Map()
		);
		await cache.set('notes', vector);
		await expect(cache.get('notes')).resolves.toEqual(vector);
	});
});
