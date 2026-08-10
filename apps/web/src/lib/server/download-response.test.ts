import { describe, expect, it } from 'vitest';
import { rangeHeaders, validateRangeHeader } from './download-response';

describe('download ranges', () => {
	it('accepts one byte range and rejects multipart or malformed ranges', () => {
		expect(validateRangeHeader('bytes=0-99')).toBe('bytes=0-99');
		expect(validateRangeHeader('bytes=-500')).toBe('bytes=-500');
		expect(() => validateRangeHeader('bytes=0-1,4-5')).toThrow();
		expect(() => validateRangeHeader('items=0-1')).toThrow();
	});

	it('returns a full response when R2 includes full-object range metadata', () => {
		expect(
			rangeHeaders(
				{
					size: 1_000,
					range: { offset: 0, length: 1_000 }
				},
				1_000,
				null
			)
		).toEqual({
			status: 200,
			contentLength: 1_000,
			contentRange: undefined
		});
	});

	it('returns a full response when R2 ignores a range request', () => {
		const expected = {
			status: 200,
			contentLength: 1_000,
			contentRange: undefined
		};
		expect(
			rangeHeaders({ size: 1_000, range: undefined }, 1_000, 'bytes=0-99')
		).toEqual(expected);
		expect(
			rangeHeaders({ size: 1_000, range: {} as R2Range }, 1_000, 'bytes=0-99')
		).toEqual(expected);
		expect(
			rangeHeaders({ size: 0, range: { offset: 0, length: 0 } }, 0, 'bytes=0-')
		).toEqual({ status: 200, contentLength: 0, contentRange: undefined });
	});

	it('builds valid offset and suffix range responses', () => {
		const offsetRange = Object.defineProperty(
			{ offset: 100, length: 200 },
			'suffix',
			{ get: () => undefined }
		);
		expect(
			rangeHeaders({ size: 1_000, range: offsetRange }, 1_000, 'bytes=100-299')
		).toEqual({
			status: 206,
			contentLength: 200,
			contentRange: 'bytes 100-299/1000'
		});
		expect(
			rangeHeaders({ size: 1_000, range: { suffix: 50 } }, 1_000, 'bytes=-50')
		).toEqual({
			status: 206,
			contentLength: 50,
			contentRange: 'bytes 950-999/1000'
		});
	});

	it('rejects non-finite range metadata', () => {
		expect(
			rangeHeaders(
				{ size: 1_000, range: { offset: Number.NaN, length: 100 } },
				1_000,
				'bytes=0-99'
			)
		).toBeNull();
	});
});
