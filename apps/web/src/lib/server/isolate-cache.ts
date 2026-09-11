export const createObjectTtlCache = <K extends object, V>(ttlMs: number) => {
	const store = new WeakMap<K, { expiresAt: number; value: V }>();
	return {
		get(key: K) {
			const cached = store.get(key);
			if (!cached) return;
			if (cached.expiresAt <= Date.now()) {
				store.delete(key);
				return;
			}
			return cached.value;
		},
		set(key: K, value: V) {
			store.set(key, { expiresAt: Date.now() + ttlMs, value });
		},
		delete(key: K) {
			store.delete(key);
		}
	};
};

// String-keyed variant for per-org caches. Expired entries are dropped on
// read and the map is bounded so a long-lived isolate serving many orgs
// cannot grow without limit.
export const createTtlCache = <V>(ttlMs: number, maxEntries = 1_000) => {
	const store = new Map<string, { expiresAt: number; value: V }>();
	return {
		get(key: string) {
			const cached = store.get(key);
			if (!cached) return;
			if (cached.expiresAt <= Date.now()) {
				store.delete(key);
				return;
			}
			return cached.value;
		},
		set(key: string, value: V) {
			if (store.size >= maxEntries) {
				const oldest = store.keys().next().value;
				if (oldest !== undefined) store.delete(oldest);
			}
			store.set(key, { expiresAt: Date.now() + ttlMs, value });
		},
		delete(key: string) {
			store.delete(key);
		}
	};
};
