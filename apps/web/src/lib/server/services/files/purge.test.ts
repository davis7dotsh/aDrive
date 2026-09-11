import { describe, expect, it } from 'vitest';
import { purgeDueAt } from './purge';

describe('purge deadline', () => {
	it('is the trash deadline for a trashed file', () => {
		expect(
			purgeDueAt({
				deleted_at: '2026-07-01T00:00:00.000Z',
				purge_at: '2026-07-31T00:00:00.000Z',
				expires_at: null
			})
		).toBe('2026-07-31T00:00:00.000Z');
	});

	it('is the expiry for a live expiring file', () => {
		expect(
			purgeDueAt({
				deleted_at: null,
				purge_at: '2026-07-31T00:00:00.000Z',
				expires_at: '2026-07-05T00:00:00.000Z'
			})
		).toBe('2026-07-05T00:00:00.000Z');
	});

	it('is the earlier of the two when both apply', () => {
		expect(
			purgeDueAt({
				deleted_at: '2026-07-01T00:00:00.000Z',
				purge_at: '2026-07-31T00:00:00.000Z',
				expires_at: '2026-07-05T00:00:00.000Z'
			})
		).toBe('2026-07-05T00:00:00.000Z');
	});

	it('is nothing for a restored file without an expiry', () => {
		expect(
			purgeDueAt({ deleted_at: null, purge_at: null, expires_at: null })
		).toBeNull();
	});
});
