import { describe, expect, it, vi } from 'vitest';
import { createObjectTtlCache } from './isolate-cache';

describe('object TTL cache', () => {
	it('returns a stored value until it expires', () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date('2026-08-18T00:00:00.000Z'));
		const key = {};
		const cache = createObjectTtlCache<object, string>(1_000);
		cache.set(key, 'fresh');
		expect(cache.get(key)).toBe('fresh');
		vi.advanceTimersByTime(999);
		expect(cache.get(key)).toBe('fresh');
		vi.advanceTimersByTime(1);
		expect(cache.get(key)).toBeUndefined();
		vi.useRealTimers();
	});

	it('keeps entries isolated per object key', () => {
		const cache = createObjectTtlCache<object, number>(60_000);
		const first = {};
		const second = {};
		cache.set(first, 1);
		cache.set(second, 2);
		cache.delete(first);
		expect(cache.get(first)).toBeUndefined();
		expect(cache.get(second)).toBe(2);
	});
});
