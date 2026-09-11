import { describe, expect, it } from 'vitest';
import { fileFamily } from './file-family';

describe('archive family fallback', () => {
	it.each([
		'backup.zip',
		'backup.ZIP',
		'backup.tar.gz',
		'backup.tar',
		'backup.tgz',
		'backup.7z',
		'backup.rar',
		'backup.bz2'
	])('recognizes a generic MIME upload named %s', (displayName) => {
		expect(
			fileFamily({
				kind: 'file',
				contentType: 'application/octet-stream',
				displayName
			})
		).toBe('archive');
	});

	it.each([
		['image/png', 'image'],
		['text/html', 'site'],
		['text/plain', 'text'],
		['application/pdf', 'doc'],
		['application/json', 'code'],
		['text/csv', 'data']
	])('preserves the recognized %s MIME family', (contentType, family) => {
		expect(
			fileFamily({ kind: 'file', contentType, displayName: 'backup.zip' })
		).toBe(family);
	});

	it('does not infer an archive from a non-terminal filename segment', () => {
		expect(
			fileFamily({
				kind: 'file',
				contentType: 'application/octet-stream',
				displayName: 'backup.zip.unknown'
			})
		).toBe('other');
	});
});
