import { describe, expect, it } from 'vitest';
import type { AuthorizedCredential } from './services/auth';
import {
	filterFilesByScope,
	isRestricted,
	restrictionMatches
} from './token-scope';

const credential = (
	restriction: AuthorizedCredential['restriction']
): AuthorizedCredential => ({
	credentialId: 'key',
	kind: 'api-key',
	scope: 'read-write',
	restriction
});

describe('token scope logic', () => {
	it('treats a null/null restriction as full-drive', () => {
		expect(isRestricted({ tagIds: null, fileIds: null })).toBe(false);
		expect(
			restrictionMatches({ tagIds: null, fileIds: null }, 'file-1', [])
		).toBe(true);
	});

	it('matches on an explicit file id', () => {
		const restriction = { tagIds: null, fileIds: ['file-1'] };
		expect(isRestricted(restriction)).toBe(true);
		expect(restrictionMatches(restriction, 'file-1', [])).toBe(true);
		expect(restrictionMatches(restriction, 'file-2', ['tag-a'])).toBe(false);
	});

	it('matches on any allowed tag (union with file ids)', () => {
		const restriction = { tagIds: ['tag-a'], fileIds: ['file-1'] };
		expect(restrictionMatches(restriction, 'file-9', ['tag-a', 'tag-b'])).toBe(
			true
		);
		expect(restrictionMatches(restriction, 'file-1', ['tag-z'])).toBe(true);
		expect(restrictionMatches(restriction, 'file-9', ['tag-z'])).toBe(false);
	});

	it('filters a listing page for a scoped credential', () => {
		const files = [
			{ id: 'file-1', tags: [{ id: 'tag-a' }] },
			{ id: 'file-2', tags: [] },
			{ id: 'file-3', tags: [{ id: 'tag-b' }] }
		];
		const scoped = credential({ tagIds: ['tag-a'], fileIds: ['file-3'] });
		expect(filterFilesByScope(scoped, files).map((file) => file.id)).toEqual([
			'file-1',
			'file-3'
		]);
		const full = credential({ tagIds: null, fileIds: null });
		expect(filterFilesByScope(full, files)).toHaveLength(3);
	});
});
