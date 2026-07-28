import { describe, expect, it } from 'vitest';
import { MisdirectedRequest } from './errors';
import { assertHostRoute, classifyRoute, normalizeOrigins } from './host-gate';

const origins = {
	dashboardOrigin: 'https://drive.example.com',
	contentOrigin: 'https://content.example.com'
};

describe('host gate', () => {
	it('refuses equal dashboard and content origins', () => {
		expect(() =>
			normalizeOrigins({
				dashboardOrigin: 'https://same.example.com',
				contentOrigin: 'https://same.example.com/'
			})
		).toThrow('must be different');
	});

	it('classifies only file-serving paths as content routes', () => {
		expect(classifyRoute('/f/3f9f')).toBe('content');
		expect(classifyRoute('/api/files')).toBe('dashboard');
		expect(classifyRoute('/')).toBe('dashboard');
	});

	it('returns a typed 421 candidate for a dashboard route on the content origin', () => {
		expect(() =>
			assertHostRoute(new URL('https://content.example.com/api/files'), origins)
		).toThrow(MisdirectedRequest);
	});

	it('returns a typed 421 candidate for a content route on the dashboard origin', () => {
		expect(() =>
			assertHostRoute(new URL('https://drive.example.com/f/file-id'), origins)
		).toThrow(MisdirectedRequest);
	});

	it('accepts each route only on its configured origin', () => {
		expect(() =>
			assertHostRoute(new URL('https://drive.example.com/api/files'), origins)
		).not.toThrow();
		expect(() =>
			assertHostRoute(new URL('https://content.example.com/f/file-id'), origins)
		).not.toThrow();
	});
});
