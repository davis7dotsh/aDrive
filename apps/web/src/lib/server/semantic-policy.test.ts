import { describe, expect, it } from 'vitest';
import {
	CHUNK_CHARACTERS,
	CHUNK_OVERLAP_CHARACTERS,
	chunkSearchText,
	indexFailureDisposition,
	newIndexLeaseToken,
	retryAt,
	safeIndexError
} from './semantic-policy';

describe('semantic indexing policy', () => {
	it('chunks deterministically with bounded overlap and a filename prefix', () => {
		const text = 'a'.repeat(CHUNK_CHARACTERS * 2);
		const chunks = chunkSearchText('notes.txt', text);
		expect(chunks).toHaveLength(3);
		expect(chunks[0]).toMatchObject({
			ordinal: 0,
			charStart: 0,
			charEnd: CHUNK_CHARACTERS
		});
		expect(chunks[0]?.text.startsWith('notes.txt\n\n')).toBe(true);
		expect(chunks[1]?.charStart).toBe(
			CHUNK_CHARACTERS - CHUNK_OVERLAP_CHARACTERS
		);
		expect(chunks.every((chunk) => chunk.text.length <= 2_011)).toBe(true);
	});

	it('embeds the filename once for empty and binary-like text', () => {
		expect(chunkSearchText('photo.jpg', '')).toEqual([
			{
				ordinal: 0,
				charStart: 0,
				charEnd: 9,
				text: 'photo.jpg\n\nphoto.jpg'
			}
		]);
	});

	it('issues url-safe lease tokens', () => {
		expect(newIndexLeaseToken()).toMatch(/^[A-Za-z0-9_-]{22}$/);
	});

	it('backs off deterministically and redacts credential-shaped errors', () => {
		const now = new Date('2026-01-01T00:00:00.000Z');
		expect(retryAt(1, now)).toBe('2026-01-01T00:01:00.000Z');
		expect(retryAt(5, now)).toBe('2026-01-01T00:16:00.000Z');
		expect(indexFailureDisposition(4, now)).toEqual({
			state: 'pending',
			nextRunAt: '2026-01-01T00:08:00.000Z'
		});
		expect(indexFailureDisposition(5, now)).toEqual({
			state: 'failed',
			nextRunAt: null
		});
		expect(safeIndexError(new Error('bad adr_abcdef_secretvalue'))).toBe(
			'bad [credential]'
		);
	});
});
