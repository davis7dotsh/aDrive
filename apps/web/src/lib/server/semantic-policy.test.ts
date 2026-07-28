import { describe, expect, it } from 'vitest';
import {
	CHUNK_CHARACTERS,
	CHUNK_OVERLAP_CHARACTERS,
	chunkSearchText,
	collapseVectorMatches,
	fileIdFromVectorId,
	indexFailureDisposition,
	newIndexLeaseToken,
	retryAt,
	safeIndexError,
	vectorIdForChunk
} from './semantic-policy';
import { searchTextLimit } from './search-text';

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

	it('uses attempt-unique vector ids within Vectorize limits', () => {
		const id = '550e8400-e29b-41d4-a716-446655440000';
		const token = newIndexLeaseToken();
		const maxOrdinal = chunkSearchText(
			'notes.txt',
			'a'.repeat(searchTextLimit)
		).at(-1)?.ordinal;
		expect(token).toMatch(/^[A-Za-z0-9_-]{22}$/);
		expect(maxOrdinal).toBeDefined();
		const vectorId = vectorIdForChunk(id, token, maxOrdinal ?? 0);
		expect(new TextEncoder().encode(vectorId).byteLength).toBeLessThanOrEqual(
			64
		);
		expect(fileIdFromVectorId(vectorId)).toBe(id);
	});

	it('max-pools chunks before ranking and reads legacy ids', () => {
		const id = '550e8400-e29b-41d4-a716-446655440000';
		expect(
			collapseVectorMatches([
				{ id: `${id}:1:0`, score: 0.5 },
				{ id: `second:1:0`, score: 0.7 },
				{ id: `${id}:1:1`, score: 0.9 },
				{ id: 'invalid', score: 1 }
			])
		).toEqual([{ fileId: id }, { fileId: 'second' }]);
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
