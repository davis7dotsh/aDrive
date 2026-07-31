import { describe, expect, it } from 'vitest';
import { InvalidRequest } from './errors';
import {
	decodeListCursor,
	encodeListCursor,
	parsePageSize
} from './list-cursor';

describe('list cursors', () => {
	it('round-trips a cursor opaquely', () => {
		const cursor = { k: '2026-07-30T00:00:00.000Z', id: 'abc-123' };
		const encoded = encodeListCursor(cursor);
		expect(encoded).not.toContain('2026');
		expect(decodeListCursor(encoded)).toEqual(cursor);
	});

	it('treats null and empty as no cursor', () => {
		expect(decodeListCursor(null)).toBeNull();
		expect(decodeListCursor('')).toBeNull();
	});

	it('rejects tampered cursors with a 400', () => {
		expect(() => decodeListCursor('not-base64!@#')).toThrow(InvalidRequest);
		expect(() => decodeListCursor('aGVsbG8')).toThrow(InvalidRequest);
		expect(() => decodeListCursor('x'.repeat(600))).toThrow(InvalidRequest);
	});

	it('bounds page sizes', () => {
		expect(parsePageSize(null, 200, 200)).toBe(200);
		expect(parsePageSize('50', 200, 200)).toBe(50);
		expect(() => parsePageSize('0', 200, 200)).toThrow(InvalidRequest);
		expect(() => parsePageSize('201', 200, 200)).toThrow(InvalidRequest);
		expect(() => parsePageSize('abc', 200, 200)).toThrow(InvalidRequest);
	});
});
