import { describe, expect, it } from 'vitest';
import {
	normalizeTagColor,
	normalizeTagName,
	uniqueTagNames
} from './tag-policy';

describe('tag normalization', () => {
	it('deduplicates case-insensitively while preserving first display capitalization', () => {
		expect(uniqueTagNames([' Report ', 'report', 'REPORTS'])).toEqual([
			'Report',
			'REPORTS'
		]);
		expect(normalizeTagName('Ｒｅｐｏｒｔ').normalizedName).toBe('report');
	});

	it('normalizes colors without inventing one', () => {
		expect(normalizeTagColor(' #AABBCC ')).toBe('#aabbcc');
		expect(normalizeTagColor(null)).toBeNull();
		expect(() => normalizeTagColor('blue')).toThrow();
	});
});
