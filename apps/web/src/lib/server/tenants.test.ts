import { expect, it } from 'vitest';
import { contentSlugFromHost } from './host-gate';
import { validateSlug } from './slug-policy';
import { personalOrgFor } from './tenants';

it.each([
	`${'a'.repeat(64)}@example.com`,
	`${'a'.repeat(26)}-${'b'.repeat(30)}@example.com`,
	'!!!@example.com',
	'café+notes@example.com'
])('generates routable content slugs for %s', (email) => {
	const { slug } = personalOrgFor(email);
	expect(validateSlug(slug)).toEqual({ ok: true, slug });
	expect(
		contentSlugFromHost(`${slug}.files.example.com`, 'files.example.com')
	).toBe(slug);
});
