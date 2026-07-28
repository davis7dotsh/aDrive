import { describe, expect, it } from 'vitest';
import { validateRangeHeader } from './download-response';

describe('download ranges', () => {
	it('accepts one byte range and rejects multipart or malformed ranges', () => {
		expect(validateRangeHeader('bytes=0-99')).toBe('bytes=0-99');
		expect(validateRangeHeader('bytes=-500')).toBe('bytes=-500');
		expect(() => validateRangeHeader('bytes=0-1,4-5')).toThrow();
		expect(() => validateRangeHeader('items=0-1')).toThrow();
	});
});
