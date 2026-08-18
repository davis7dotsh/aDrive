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
