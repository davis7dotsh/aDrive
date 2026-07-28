import { describe, expect, it } from 'vitest';
import {
	cleanContentType,
	cleanFileName,
	contentTypeForUpload,
	trashWindow,
	visibilityForFile
} from './file-policy';

describe('file policy', () => {
	it('normalizes names and content types at the server boundary', () => {
		expect(cleanFileName('/tmp/report.txt')).toBe('report.txt');
		expect(cleanContentType('TEXT/PLAIN; charset=utf-8')).toBe('text/plain');
		expect(cleanContentType('not a mime')).toBe('application/octet-stream');
		expect(() => cleanFileName('bad\u0000name')).toThrow();
	});

	it('forces HTML public from either the file name or content type', () => {
		expect(contentTypeForUpload('index.HTML', 'application/octet-stream')).toBe(
			'text/html'
		);
		expect(visibilityForFile('index.html', 'text/html', false)).toEqual({
			public: true,
			forcedPublic: true
		});
		expect(visibilityForFile('render.bin', 'text/html', false)).toEqual({
			public: true,
			forcedPublic: true
		});
	});

	it('allows non-HTML files to change visibility in either direction', () => {
		expect(visibilityForFile('report.pdf', 'application/pdf', false)).toEqual({
			public: false,
			forcedPublic: false
		});
		expect(visibilityForFile('report.pdf', 'application/pdf', true)).toEqual({
			public: true,
			forcedPublic: false
		});
	});

	it('gives trash a stable thirty-day restore window', () => {
		const now = new Date('2026-07-27T12:00:00.000Z');
		expect(trashWindow(null, now)).toEqual({
			deletedAt: '2026-07-27T12:00:00.000Z',
			purgeAt: '2026-08-26T12:00:00.000Z'
		});
		expect(trashWindow('2026-07-01T00:00:00.000Z', now)).toEqual({
			deletedAt: '2026-07-01T00:00:00.000Z',
			purgeAt: '2026-07-31T00:00:00.000Z'
		});
	});
});
