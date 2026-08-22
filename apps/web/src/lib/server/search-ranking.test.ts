import { describe, expect, it } from 'vitest';
import {
	matchesAnyTag,
	pinExactName,
	reciprocalRankFusion,
	sanitizeMatchQuery,
	sanitizeTrigramQuery,
	shouldEmbedSearchQuery
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

	it('skips Workers AI embeddings for queries too short to be semantic', () => {
		expect(shouldEmbedSearchQuery('ab')).toBe(false);
		expect(shouldEmbedSearchQuery('  a  ')).toBe(false);
		expect(shouldEmbedSearchQuery('orbit')).toBe(true);
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

	it('fuses a max-pooled semantic file list as an equal third source', () => {
		const result = reciprocalRankFusion({
			keyword: {
				results: [{ fileId: 'keyword' }, { fileId: 'shared' }],
				weight: 1
			},
			trigram: { results: [{ fileId: 'typo' }], weight: 0.5 },
			semantic: {
				results: [{ fileId: 'meaning' }, { fileId: 'shared' }],
				weight: 1
			}
		});
		expect(result.map((row) => row.fileId)).toEqual([
			'shared',
			'keyword',
			'meaning',
			'typo'
		]);
		expect(result[0]?.ranks).toEqual({ keyword: 2, semantic: 2 });
	});

	it('returns more than 50 rows when the caller asks for a deeper page window', () => {
		const keyword = {
			results: Array.from({ length: 60 }, (_, index) => ({
				fileId: `k${String(index).padStart(2, '0')}`
			})),
			weight: 1
		};
		expect(reciprocalRankFusion({ keyword }, 55)).toHaveLength(55);
	});

	it('keeps page slices disjoint when the fusion window stays fixed', () => {
		const keyword = {
			results: Array.from({ length: 60 }, (_, index) => ({
				fileId: `k${String(index).padStart(2, '0')}`
			})),
			weight: 1
		};
		const fused = reciprocalRankFusion({ keyword }, 200);
		const page0 = fused.slice(0, 50).map((entry) => entry.fileId);
		const page1 = fused.slice(50, 100).map((entry) => entry.fileId);
		expect(page0).toHaveLength(50);
		expect(page1).toHaveLength(10);
		expect(page0.some((id) => page1.includes(id))).toBe(false);
	});

	it('keeps keyword-only ordering and scores identical with an empty semantic source', () => {
		const sources = {
			keyword: {
				results: [{ fileId: 'first' }, { fileId: 'second' }],
				weight: 1
			},
			trigram: { results: [{ fileId: 'second' }], weight: 0.5 }
		};
		expect(
			reciprocalRankFusion({
				...sources,
				semantic: { results: [], weight: 1 }
			})
		).toEqual(reciprocalRankFusion(sources));
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
