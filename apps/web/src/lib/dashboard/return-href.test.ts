import { describe, expect, it } from 'vitest';
import { dashboardReturnHref } from './return-href';

describe('dashboard return navigation', () => {
	it('preserves the design and filters through an encoded detail link', () => {
		const dashboard = new URL(
			'https://dashboard.example/E?q=design+review&tags=one%2Ctwo&view=trash&layout=list&sort=name'
		);
		const from = dashboardReturnHref(dashboard.pathname + dashboard.search);
		const detail = new URL(
			`/files/file-id?from=${encodeURIComponent(from)}`,
			dashboard
		);
		expect(dashboardReturnHref(detail.searchParams.get('from'))).toBe(
			dashboard.pathname + dashboard.search
		);
	});

	it.each(['/', '/A', '/b', '/C?q=test', '/d?layout=list', '/E'])(
		'accepts the dashboard location %s',
		(href) => expect(dashboardReturnHref(href)).toBe(href)
	);

	it('preserves existing query-only return links', () => {
		expect(dashboardReturnHref('?q=old+link&view=trash')).toBe(
			'/?q=old+link&view=trash'
		);
		expect(dashboardReturnHref(null)).toBe('/');
	});

	it.each([
		'https://evil.example/',
		'//evil.example/',
		'/\\evil.example/',
		'javascript:alert(1)',
		'/settings',
		'/E/../settings',
		'/%45',
		'/F',
		'/E#fragment',
		'/E\n',
		'/E\n?query=test'
	])('rejects return locations outside the dashboard allowlist: %s', (from) => {
		expect(dashboardReturnHref(from)).toBe('/');
	});
});
