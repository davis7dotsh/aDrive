import { describe, expect, it } from 'vitest';
import { listingMode } from './listing';

describe('listingMode', () => {
	it('routes trash view to the trash list', () => {
		expect(listingMode('trash', 'needle', ['t1'])).toEqual({
			kind: 'list',
			trashed: true
		});
	});

	it('routes query or tags to search', () => {
		expect(listingMode('files', 'needle', [])).toEqual({
			kind: 'search',
			query: 'needle',
			tags: []
		});
		expect(listingMode(null, '   ', ['t1'])).toEqual({
			kind: 'search',
			query: '',
			tags: ['t1']
		});
	});

	it('routes plain views to the untrashed list', () => {
		expect(listingMode(null, '', [])).toEqual({ kind: 'list', trashed: false });
		expect(listingMode('files', '  ', [])).toEqual({
			kind: 'list',
			trashed: false
		});
	});

	it('trims the query for search mode', () => {
		expect(listingMode(null, '  needle  ', [])).toEqual({
			kind: 'search',
			query: 'needle',
			tags: []
		});
	});
});
