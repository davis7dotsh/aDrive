import { describe, expect, it } from 'vitest';
import {
	matchesAnyTag,
	pinExactName,
	reciprocalRankFusion,
	sanitizeMatchQuery,
	sanitizeTrigramQuery
} from './search-ranking';

describe('search query sanitization', () => {
	it('turns arbitrary punctuation into safe quoted terms', () => {
		expect(sanitizeMatchQuery('"orbit": manifest—2026 (')).toBe(
			'"orbit" "manifest" "2026"*'
		);
		expect(sanitizeMatchQuery('":-*()')).toBeNull();
	});

	it('builds only quoted OR-connected trigrams', () => {
		expect(sanitizeTrigramQuery('A:B')).toBe('"a b"');
		expect(sanitizeTrigramQuery('ab')).toBeNull();
	});
});

describe('reciprocal rank fusion', () => {
	it('uses k=60 and a half-weight trigram source', () => {
		const result = reciprocalRankFusion({
			keyword: {
				results: [{ fileId: 'keyword' }, { fileId: 'both' }],
				weight: 1
			},
			trigram: {
				results: [{ fileId: 'both' }, { fileId: 'fuzzy' }],
				weight: 0.5
			}
		});
		expect(result[0]?.fileId).toBe('both');
		expect(result.find((item) => item.fileId === 'keyword')?.score).toBeCloseTo(
			1 / 61
		);
		expect(result.find((item) => item.fileId === 'fuzzy')?.score).toBeCloseTo(
			0.5 / 62
		);
	});
});

describe('authoritative result helpers', () => {
	it('pins a case-insensitive exact filename first', () => {
		const files = [{ displayName: 'other.txt' }, { displayName: 'Orbit.txt' }];
		expect(pinExactName(' orbit.TXT ', files)[0]?.displayName).toBe(
			'Orbit.txt'
		);
	});

	it('uses OR semantics for selected tags', () => {
		expect(matchesAnyTag(['a'], ['b', 'a'])).toBe(true);
		expect(matchesAnyTag(['a'], ['b', 'c'])).toBe(false);
		expect(matchesAnyTag(['a'], [])).toBe(true);
	});
});
