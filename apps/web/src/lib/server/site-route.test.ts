import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { sitePathCandidates } from '@adrive/shared';

const routeSource = readFileSync(
	new URL('../../routes/s/[id]/[...path]/+server.ts', import.meta.url),
	'utf8'
);
const kitUrlModule: unknown = await import(
	new URL(
		'../../../node_modules/@sveltejs/kit/src/utils/url.js',
		import.meta.url
	).href
);

const normalizePath = (path: string, trailingSlash: string) => {
	if (
		typeof kitUrlModule !== 'object' ||
		kitUrlModule === null ||
		!('normalize_path' in kitUrlModule) ||
		typeof kitUrlModule.normalize_path !== 'function'
	) {
		throw new Error('Installed SvelteKit normalize_path is unavailable');
	}
	const result: unknown = Reflect.apply(
		kitUrlModule.normalize_path,
		undefined,
		[path, trailingSlash]
	);
	if (typeof result !== 'string') {
		throw new Error('Installed SvelteKit normalize_path returned a non-string');
	}
	return result;
};

describe('static site route canonicalization', () => {
	it('configures the endpoint to preserve both slash forms without redirects', () => {
		expect(routeSource).toMatch(/export const trailingSlash = ['"]ignore['"];/);
		expect(normalizePath('/s/site-id/', 'ignore')).toBe('/s/site-id/');
		expect(normalizePath('/s/site-id/app.js', 'ignore')).toBe(
			'/s/site-id/app.js'
		);
	});

	it('keeps relative assets under the stable slash-terminated site root', () => {
		const root = new URL('/s/site-id/', 'https://content.example.com');
		expect(new URL('assets/app.js', root).pathname).toBe(
			'/s/site-id/assets/app.js'
		);
		expect(
			new URL(
				'assets/app.js',
				new URL('/s/site-id', 'https://content.example.com')
			).pathname
		).toBe('/s/assets/app.js');
	});

	it('preserves exact assets and directory index resolution', () => {
		expect(sitePathCandidates('app.js')).toEqual([
			'app.js',
			'app.js/index.html'
		]);
		expect(sitePathCandidates('docs/')).toEqual(['docs/index.html']);
	});
});
