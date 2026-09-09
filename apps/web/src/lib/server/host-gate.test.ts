import { describe, expect, it } from 'vitest';
import { MisdirectedRequest } from './errors';
import {
	assertHostRoute,
	classifyRoute,
	contentOriginFor,
	contentSlugFromHost,
	normalizeOrigins
} from './host-gate';

const origins = {
	dashboardOrigin: 'https://drive.example.com',
	contentDomain: 'content.example.com'
};

describe('host gate', () => {
	it('refuses a dashboard origin under the content domain', () => {
		expect(() =>
			normalizeOrigins({
				dashboardOrigin: 'https://same.example.com',
				contentDomain: 'same.example.com'
			})
		).toThrow('must not live under');
		expect(() =>
			normalizeOrigins({
				dashboardOrigin: 'https://app.same.example.com',
				contentDomain: 'same.example.com'
			})
		).toThrow('must not live under');
	});

	it('requires a bare content domain and derives the scheme from the dashboard', () => {
		expect(() =>
			normalizeOrigins({
				dashboardOrigin: 'https://drive.example.com',
				contentDomain: 'https://content.example.com'
			})
		).toThrow('bare hostname');
		expect(() =>
			normalizeOrigins({
				dashboardOrigin: 'https://drive.example.com',
				contentDomain: 'content.example.com/path'
			})
		).toThrow('bare hostname');
		expect(normalizeOrigins(origins)).toEqual({
			dashboardOrigin: 'https://drive.example.com',
			contentDomain: 'content.example.com',
			contentScheme: 'https:'
		});
		expect(
			normalizeOrigins({
				dashboardOrigin: 'http://localhost:5173',
				contentDomain: 'localhost:5174'
			})
		).toEqual({
			dashboardOrigin: 'http://localhost:5173',
			contentDomain: 'localhost:5174',
			contentScheme: 'http:'
		});
	});

	it('classifies only file-serving paths as content routes', () => {
		expect(classifyRoute('/f/3f9f')).toBe('content');
		expect(classifyRoute('/t/3f9f/1/grid.webp')).toBe('content');
		expect(classifyRoute('/s/3f9f/assets/app.js')).toBe('content');
		expect(classifyRoute('/api/files')).toBe('dashboard');
		expect(classifyRoute('/mcp')).toBe('dashboard');
		expect(classifyRoute('/')).toBe('dashboard');
	});

	it('reads the slug from the leading host label only', () => {
		expect(
			contentSlugFromHost('acme.content.example.com', origins.contentDomain)
		).toBe('acme');
		expect(
			contentSlugFromHost('ACME.Content.Example.com', origins.contentDomain)
		).toBe('acme');
		expect(contentSlugFromHost('acme.localhost:5174', 'localhost:5174')).toBe(
			'acme'
		);
		expect(
			contentSlugFromHost('content.example.com', origins.contentDomain)
		).toBeNull();
		expect(
			contentSlugFromHost('a.b.content.example.com', origins.contentDomain)
		).toBeNull();
		expect(
			contentSlugFromHost('ab.content.example.com', origins.contentDomain)
		).toBeNull();
		expect(
			contentSlugFromHost(
				'under_score.content.example.com',
				origins.contentDomain
			)
		).toBeNull();
		expect(
			contentSlugFromHost('acme.other.example.com', origins.contentDomain)
		).toBeNull();
	});

	it('builds one origin per org', () => {
		expect(contentOriginFor('https:', 'content.example.com', 'acme')).toBe(
			'https://acme.content.example.com'
		);
		expect(contentOriginFor('http:', 'localhost:5174', 'acme')).toBe(
			'http://acme.localhost:5174'
		);
	});

	it('returns a typed 421 candidate for a dashboard route on a content host', () => {
		expect(() =>
			assertHostRoute(
				new URL('https://acme.content.example.com/api/files'),
				origins
			)
		).toThrow(MisdirectedRequest);
	});

	it('returns a typed 421 candidate for a content route off the content domain', () => {
		expect(() =>
			assertHostRoute(new URL('https://drive.example.com/f/file-id'), origins)
		).toThrow(MisdirectedRequest);
		expect(() =>
			assertHostRoute(new URL('https://content.example.com/f/file-id'), origins)
		).toThrow(MisdirectedRequest);
		expect(() =>
			assertHostRoute(
				new URL('http://acme.content.example.com/f/file-id'),
				origins
			)
		).toThrow(MisdirectedRequest);
	});

	it('accepts each route only on its host and names the slug', () => {
		expect(
			assertHostRoute(new URL('https://drive.example.com/api/files'), origins)
		).toEqual({ route: 'dashboard' });
		expect(
			assertHostRoute(new URL('https://drive.example.com/mcp'), origins)
		).toEqual({ route: 'dashboard' });
		expect(() =>
			assertHostRoute(new URL('https://acme.content.example.com/mcp'), origins)
		).toThrow(MisdirectedRequest);
		expect(
			assertHostRoute(
				new URL('https://acme.content.example.com/f/file-id'),
				origins
			)
		).toEqual({ route: 'content', slug: 'acme' });
	});
});
