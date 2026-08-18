import type { AuthGuardStoreShape } from './services/bindings';

export const QUERY_EMBED_KV_PREFIX = 'v1:query-embed:';
export const QUERY_EMBED_KV_TTL_SECONDS = 60 * 60;
export const QUERY_EMBED_MEMORY_TTL_MS = 10 * 60 * 1_000;
export const QUERY_EMBED_MEMORY_LIMIT = 200;

const toHex = (bytes: ArrayBuffer) =>
	Array.from(new Uint8Array(bytes), (byte) =>
		byte.toString(16).padStart(2, '0')
	).join('');

export const normalizeQueryForEmbed = (query: string) =>
	query.normalize('NFKC').trim().slice(0, 256);

export const parseStoredEmbedding = (value: string | null) => {
	if (value === null) return null;
	try {
		const parsed: unknown = JSON.parse(value);
		if (
			!Array.isArray(parsed) ||
			parsed.length !== 384 ||
			parsed.some((item) => typeof item !== 'number' || !Number.isFinite(item))
		) {
			return null;
		}
		return parsed;
	} catch {
		return null;
	}
};

interface MemoryEntry {
	readonly expiresAt: number;
	readonly vector: ReadonlyArray<number>;
}

const isolateMemory = new Map<string, MemoryEntry>();

export class QueryEmbeddingCache {
	constructor(
		private readonly store: AuthGuardStoreShape | null,
		private readonly memory: Map<string, MemoryEntry> = isolateMemory
	) {}

	async digestKey(query: string) {
		const digest = await crypto.subtle.digest(
			'SHA-256',
			new TextEncoder().encode(normalizeQueryForEmbed(query))
		);
		return `${QUERY_EMBED_KV_PREFIX}${toHex(digest)}`;
	}

	getMemory(query: string) {
		const normalized = normalizeQueryForEmbed(query);
		const cached = this.memory.get(normalized);
		if (!cached) return null;
		if (cached.expiresAt <= Date.now()) {
			this.memory.delete(normalized);
			return null;
		}
		return cached.vector;
	}

	setMemory(query: string, vector: ReadonlyArray<number>) {
		const normalized = normalizeQueryForEmbed(query);
		if (this.memory.size >= QUERY_EMBED_MEMORY_LIMIT) {
			const oldest = this.memory.keys().next().value;
			if (oldest !== undefined) this.memory.delete(oldest);
		}
		this.memory.set(normalized, {
			expiresAt: Date.now() + QUERY_EMBED_MEMORY_TTL_MS,
			vector
		});
	}

	async get(query: string) {
		const memory = this.getMemory(query);
		if (memory) return memory;
		if (!this.store) return null;
		try {
			const stored = parseStoredEmbedding(
				await this.store.get(await this.digestKey(query))
			);
			if (stored) this.setMemory(query, stored);
			return stored;
		} catch {
			return null;
		}
	}

	async set(query: string, vector: ReadonlyArray<number>) {
		this.setMemory(query, vector);
		if (!this.store) return;
		try {
			await this.store.put(
				await this.digestKey(query),
				JSON.stringify(vector),
				{
					expirationTtl: QUERY_EMBED_KV_TTL_SECONDS
				}
			);
		} catch {
			// Memory still holds the vector if KV is unavailable.
		}
	}
}

export const createQueryEmbeddingCache = (store: AuthGuardStoreShape | null) =>
	new QueryEmbeddingCache(store);
