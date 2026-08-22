import { describe, expect, it } from 'vitest';
import {
	DASHBOARD_RENDERED_THUMBNAIL,
	DASHBOARD_THUMBNAIL,
	dashboardSiteThumbnailSourceUrl,
	dashboardThumbnailPrefix,
	dashboardThumbnailSourceUrl,
	dashboardThumbnailUrl,
	isTransformedWebpResponse,
	isWebpContentType,
	matchesEtag,
	supportsDashboardThumbnail,
	supportsRenderedDashboardThumbnail
} from './file-thumbnail';

describe('dashboard thumbnails', () => {
	it('uses one bounded WebP transform for the grid', () => {
		expect(DASHBOARD_THUMBNAIL).toEqual({
			width: 480,
			height: 360,
			fit: 'cover',
			format: 'webp',
			quality: 75,
			anim: false,
			metadata: 'none'
		});
		expect(dashboardThumbnailPrefix('file-id', 3)).toBe('thumbnail/file-id/3/');
	});

	it('accepts parameterized WebP responses and matches cached validators', () => {
		expect(isWebpContentType('image/webp')).toBe(true);
		expect(isWebpContentType('Image/WebP; charset=binary')).toBe(true);
		expect(isWebpContentType('image/png')).toBe(false);
		expect(isTransformedWebpResponse('image/webp', 'quality=75')).toBe(true);
		expect(
			isTransformedWebpResponse('image/webp', 'quality=75, err=9401')
		).toBe(false);
		expect(isTransformedWebpResponse('image/webp', '')).toBe(false);
		expect(isTransformedWebpResponse('image/webp', null)).toBe(false);
		expect(matchesEtag('"other", "current"', '"current"')).toBe(true);
		expect(matchesEtag('W/"current"', '"current"')).toBe(true);
		expect(matchesEtag('"current"', 'W/"current"')).toBe(true);
		expect(matchesEtag('*', '"current"')).toBe(true);
		expect(matchesEtag('"other"', '"current"')).toBe(false);
	});

	it('resizes raster images but leaves SVG and non-images alone', () => {
		expect(supportsDashboardThumbnail('image/jpeg')).toBe(true);
		expect(supportsDashboardThumbnail(' IMAGE/PNG; charset=binary')).toBe(true);
		expect(supportsDashboardThumbnail('image/avif')).toBe(true);
		expect(supportsDashboardThumbnail('image/heic')).toBe(true);
		expect(supportsDashboardThumbnail('image/svg+xml')).toBe(false);
		expect(supportsDashboardThumbnail('image/bmp')).toBe(false);
		expect(supportsDashboardThumbnail('image/tiff')).toBe(false);
		expect(supportsDashboardThumbnail('application/pdf')).toBe(false);
	});

	it('renders HTML and sites into bounded WebP screenshots', () => {
		expect(supportsRenderedDashboardThumbnail('site', 'text/html')).toBe(true);
		expect(
			supportsRenderedDashboardThumbnail('file', ' TEXT/HTML; charset=utf-8')
		).toBe(true);
		expect(supportsRenderedDashboardThumbnail('file', 'image/png')).toBe(false);
		expect(DASHBOARD_RENDERED_THUMBNAIL.viewport).toEqual({
			width: 1_200,
			height: 900,
			deviceScaleFactor: 1
		});
		expect(DASHBOARD_RENDERED_THUMBNAIL.screenshotOptions).toEqual({
			type: 'webp',
			quality: 75,
			clip: { x: 0, y: 0, width: 1_200, height: 900, scale: 0.4 }
		});
		expect(DASHBOARD_RENDERED_THUMBNAIL.gotoOptions).toEqual({
			waitUntil: 'networkidle2',
			timeout: 15_000
		});
	});

	it('preserves private grants when changing a content link to a thumbnail', () => {
		expect(
			dashboardThumbnailUrl(
				'https://files.example/f/file-id?v=3&e=123&g=signed&preview=dashboard',
				'file id',
				3
			)
		).toBe('https://files.example/t/file%20id/3/grid.webp?e=123&g=signed');
	});

	it('moves a signed site grant into the screenshot thumbnail URL', () => {
		const signature = 'a'.repeat(43);
		expect(
			dashboardThumbnailUrl(
				`https://files.example/s/site-id/@grant/3/123/${signature}/`,
				'site-id',
				3
			)
		).toBe(`https://files.example/t/site-id/3/grid.webp?e=123&g=${signature}`);
	});

	it('builds a versioned origin URL that does not count as a download', () => {
		expect(
			dashboardThumbnailSourceUrl('https://files.example', 'file id', 3, {
				expires: '123',
				signature: 'signed'
			}).href
		).toBe(
			'https://files.example/f/file%20id?v=3&purpose=thumbnail&e=123&g=signed'
		);
	});

	it('builds a signed site URL that marks screenshot-only navigation', () => {
		expect(
			dashboardSiteThumbnailSourceUrl('https://files.example', 'site id', 3, {
				expires: '123',
				signature: 'signed'
			}).href
		).toBe(
			'https://files.example/s/site%20id/@grant/3/123/signed/?purpose=thumbnail'
		);
	});
});
