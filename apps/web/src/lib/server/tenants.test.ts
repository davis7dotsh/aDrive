import { expect, it } from 'vitest';
import { contentSlugFromHost } from './host-gate';
import { SLUG_MAX_LENGTH, validateSlug } from './slug-policy';
import { personalOrgFor } from './tenants';

it.each([
	`${'a'.repeat(64)}@example.com`,
	`${'a'.repeat(26)}-${'b'.repeat(30)}@example.com`,
	`${'a'.repeat(14)}-${'b'.repeat(30)}@example.com`,
	'!!!@example.com',
	'café+notes@example.com'
])('generates routable content slugs for %s', (email) => {
	const { slug } = personalOrgFor(email);
	expect(slug.length).toBeLessThanOrEqual(SLUG_MAX_LENGTH);
	expect(slug).toMatch(/-[0-9a-f]{16}$/);
	expect(validateSlug(slug)).toEqual({ ok: true, slug });
	expect(
		contentSlugFromHost(`${slug}.files.example.com`, 'files.example.com')
	).toBe(slug);
});

it('uses the full slug budget for a long readable prefix and random suffix', () => {
	const { slug } = personalOrgFor(`${'a'.repeat(64)}@example.com`);
	expect(slug).toHaveLength(SLUG_MAX_LENGTH);
});
