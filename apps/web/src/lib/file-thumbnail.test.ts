import { describe, expect, it } from 'vitest';
import {
	DASHBOARD_THUMBNAIL,
	dashboardThumbnailKey,
	dashboardThumbnailSourceUrl,
	dashboardThumbnailUrl,
	isTransformedWebpResponse,
	isWebpContentType,
	matchesEtag,
	supportsDashboardThumbnail
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
		expect(dashboardThumbnailKey('file-id', 3)).toBe(
			'thumbnail/file-id/3/grid.webp'
		);
	});

	it('accepts parameterized WebP responses and matches cached validators', () => {
		expect(isWebpContentType('image/webp')).toBe(true);
		expect(isWebpContentType('Image/WebP; charset=binary')).toBe(true);
		expect(isWebpContentType('image/png')).toBe(false);
		expect(isTransformedWebpResponse('image/webp', 'quality=75')).toBe(true);
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

	it('preserves private grants when changing a content link to a thumbnail', () => {
		expect(
			dashboardThumbnailUrl(
				'https://files.example/f/file-id?v=3&e=123&g=signed&preview=dashboard',
				'file id',
				3
			)
		).toBe('https://files.example/t/file%20id/3/grid.webp?e=123&g=signed');
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
});
