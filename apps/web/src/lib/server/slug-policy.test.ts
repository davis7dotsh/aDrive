import { describe, expect, it } from 'vitest';
import {
	RESERVED_SLUGS,
	SLUG_CHANGE_INTERVAL_MS,
	nextSlugChangeAt,
	validateSlug
} from './slug-policy';

describe('slug policy', () => {
	it('accepts lowercase alphanumerics and inner hyphens', () => {
		expect(validateSlug('acme')).toEqual({ ok: true, slug: 'acme' });
		expect(validateSlug('acme-labs-2')).toEqual({
			ok: true,
			slug: 'acme-labs-2'
		});
		expect(validateSlug('  Acme  ')).toEqual({ ok: true, slug: 'acme' });
	});

	it('enforces the length bounds', () => {
		expect(validateSlug('ab').ok).toBe(false);
		expect(validateSlug('a'.repeat(32)).ok).toBe(true);
		expect(validateSlug('a'.repeat(33)).ok).toBe(false);
	});

	it('rejects leading, trailing, and doubled hyphens and other characters', () => {
		expect(validateSlug('-acme').ok).toBe(false);
		expect(validateSlug('acme-').ok).toBe(false);
		expect(validateSlug('ac--me').ok).toBe(false);
		expect(validateSlug('ac_me').ok).toBe(false);
		expect(validateSlug('ac.me').ok).toBe(false);
		expect(validateSlug('acmé').ok).toBe(false);
	});

	it('rejects every reserved label regardless of case', () => {
		for (const reserved of RESERVED_SLUGS) {
			expect(validateSlug(reserved)).toEqual({
				ok: false,
				message: 'That slug is reserved'
			});
			expect(validateSlug(reserved.toUpperCase()).ok).toBe(false);
		}
	});

	it('allows one change per thirty days', () => {
		const now = new Date('2026-09-09T00:00:00.000Z');
		expect(nextSlugChangeAt(null, now)).toBeNull();
		expect(nextSlugChangeAt('2026-08-01T00:00:00.000Z', now)).toBeNull();
		const recent = new Date(now.getTime() - SLUG_CHANGE_INTERVAL_MS + 1_000);
		expect(nextSlugChangeAt(recent.toISOString(), now)).toBe(
			new Date(recent.getTime() + SLUG_CHANGE_INTERVAL_MS).toISOString()
		);
	});
});
