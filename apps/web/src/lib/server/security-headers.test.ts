import { describe, expect, it } from 'vitest';
import { applySecurityHeaders } from './security-headers';

const context = {
	pathname: '/',
	requestOrigin: 'https://drive.example.com',
	contentOrigin: 'https://files.example.com'
};

const htmlResponse = (csp?: string) =>
	new Response('<!doctype html>', {
		headers: {
			'Content-Type': 'text/html; charset=utf-8',
			...(csp ? { 'Content-Security-Policy': csp } : {})
		}
	});

describe('applySecurityHeaders', () => {
	it('sets baseline headers on dashboard HTML', () => {
		const response = applySecurityHeaders(htmlResponse(), context);
		expect(response.headers.get('X-Content-Type-Options')).toBe('nosniff');
		expect(response.headers.get('Referrer-Policy')).toBe(
			'strict-origin-when-cross-origin'
		);
		expect(response.headers.get('Permissions-Policy')).toContain('camera=()');
		expect(response.headers.get('Strict-Transport-Security')).toContain(
			'max-age='
		);
	});

	it('omits HSTS on http origins', () => {
		const response = applySecurityHeaders(htmlResponse(), {
			...context,
			requestOrigin: 'http://localhost:5173'
		});
		expect(response.headers.get('Strict-Transport-Security')).toBeNull();
	});

	it('builds a dashboard CSP embedding the content origin', () => {
		const response = applySecurityHeaders(htmlResponse(), context);
		const csp = response.headers.get('Content-Security-Policy') ?? '';
		expect(csp).toContain(`default-src 'self'`);
		expect(csp).toContain(`frame-src https://files.example.com`);
		expect(csp).toContain(`connect-src 'self' https://files.example.com`);
		expect(csp).toContain(`frame-ancestors 'none'`);
		expect(csp).toContain(`object-src 'none'`);
	});

	it('preserves the SvelteKit script-src nonce', () => {
		const response = applySecurityHeaders(
			htmlResponse(`script-src 'self' 'nonce-abc123'`),
			context
		);
		const csp = response.headers.get('Content-Security-Policy') ?? '';
		expect(csp).toContain(`script-src 'self' 'nonce-abc123'`);
	});

	it('leaves content-route CSP untouched', () => {
		const response = applySecurityHeaders(
			new Response('bytes', {
				headers: {
					'Content-Type': 'text/html',
					'Content-Security-Policy': `default-src 'none'; sandbox`
				}
			}),
			{ ...context, pathname: '/f/abc' }
		);
		expect(response.headers.get('Content-Security-Policy')).toBe(
			`default-src 'none'; sandbox`
		);
	});

	it('does not override an existing Referrer-Policy', () => {
		const base = new Response('bytes', {
			headers: { 'Referrer-Policy': 'no-referrer' }
		});
		const response = applySecurityHeaders(base, {
			...context,
			pathname: '/f/abc'
		});
		expect(response.headers.get('Referrer-Policy')).toBe('no-referrer');
	});

	it('marks API responses private and uncacheable', () => {
		const response = applySecurityHeaders(
			new Response('{}', {
				headers: { 'Content-Type': 'application/json' }
			}),
			{ ...context, pathname: '/api/files' }
		);
		expect(response.headers.get('Cache-Control')).toBe('private, no-store');
	});

	it('keeps a route-supplied Cache-Control', () => {
		const response = applySecurityHeaders(
			new Response('{}', {
				headers: {
					'Content-Type': 'application/json',
					'Cache-Control': 'public, max-age=60'
				}
			}),
			{ ...context, pathname: '/api/files' }
		);
		expect(response.headers.get('Cache-Control')).toBe('public, max-age=60');
	});

	it('applies no dashboard CSP to non-HTML API responses', () => {
		const response = applySecurityHeaders(
			new Response('{}', {
				headers: { 'Content-Type': 'application/json' }
			}),
			context
		);
		expect(response.headers.get('Content-Security-Policy')).toBeNull();
		expect(response.headers.get('X-Content-Type-Options')).toBe('nosniff');
	});
});
