export const DASHBOARD_THUMBNAIL = {
	width: 480,
	height: 360,
	fit: 'cover',
	format: 'webp',
	quality: 75,
	anim: false,
	metadata: 'none'
} as const;

export const DASHBOARD_RENDERED_THUMBNAIL = {
	viewport: {
		width: 1_200,
		height: 900,
		deviceScaleFactor: 1
	},
	screenshotOptions: {
		type: 'webp',
		quality: DASHBOARD_THUMBNAIL.quality,
		clip: {
			x: 0,
			y: 0,
			width: 1_200,
			height: 900,
			scale: DASHBOARD_THUMBNAIL.width / 1_200
		}
	},
	gotoOptions: {
		waitUntil: 'networkidle2',
		timeout: 15_000
	},
	bestAttempt: true,
	allowResourceTypes: ['document', 'stylesheet', 'image', 'font', 'script']
} as const satisfies Omit<BrowserRunScreenshotOptions, 'url' | 'html'>;

export const dashboardRenderedThumbnailRequestPattern = (
	contentOrigin: string
) =>
	`^${new URL(contentOrigin).origin.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?:/|$)`;

export const dashboardThumbnailPrefix = (id: string, version: number) =>
	`thumbnail/${id}/${version}/`;

const TRANSFORMABLE_IMAGE_TYPES = new Set([
	'image/jpeg',
	'image/png',
	'image/gif',
	'image/webp',
	'image/avif',
	'image/heic'
]);

export const supportsDashboardThumbnail = (contentType: string) => {
	const normalized = contentType.split(';', 1)[0]?.trim().toLowerCase();
	return normalized !== undefined && TRANSFORMABLE_IMAGE_TYPES.has(normalized);
};

export const supportsRenderedDashboardThumbnail = (
	kind: 'file' | 'site',
	contentType: string
) =>
	kind === 'site' ||
	contentType.split(';', 1)[0]?.trim().toLowerCase() === 'text/html';

export const isWebpContentType = (contentType: string | null) =>
	contentType?.split(';', 1)[0]?.trim().toLowerCase() === 'image/webp';

export const isTransformedWebpResponse = (
	contentType: string | null,
	cfResized: string | null
) =>
	cfResized !== null &&
	cfResized.trim().length > 0 &&
	!/(?:^|[;,])\s*err\s*=/i.test(cfResized) &&
	isWebpContentType(contentType);

const weakEtag = (value: string) => value.trim().replace(/^W\//, '');

export const matchesEtag = (header: string | null, etag: string) =>
	header
		?.split(',')
		.some(
			(candidate) =>
				candidate.trim() === '*' || weakEtag(candidate) === weakEtag(etag)
		) ?? false;

export const dashboardThumbnailUrl = (
	contentUrl: string,
	id: string,
	version: number
) => {
	const url = new URL(contentUrl);
	const siteGrant = url.pathname.match(
		/\/@grant\/\d+\/(?<expires>\d+)\/(?<signature>[A-Za-z0-9_-]{43})(?:\/|$)/
	);
	if (siteGrant?.groups) {
		url.searchParams.set('e', siteGrant.groups.expires ?? '');
		url.searchParams.set('g', siteGrant.groups.signature ?? '');
	}
	url.pathname = `/t/${encodeURIComponent(id)}/${version}/grid.webp`;
	url.searchParams.delete('v');
	url.searchParams.delete('preview');
	return url.href;
};

export const dashboardThumbnailSourceUrl = (
	contentOrigin: string,
	id: string,
	version: number,
	grant: { readonly expires: string; readonly signature: string } | null
) => {
	const url = new URL(`/f/${encodeURIComponent(id)}`, contentOrigin);
	url.searchParams.set('v', String(version));
	url.searchParams.set('purpose', 'thumbnail');
	if (grant) {
		url.searchParams.set('e', grant.expires);
		url.searchParams.set('g', grant.signature);
	}
	return url;
};

export const dashboardSiteThumbnailSourceUrl = (
	contentOrigin: string,
	id: string,
	version: number,
	grant: { readonly expires: string; readonly signature: string },
	thumbnailGrant: { readonly expires: string; readonly signature: string }
) => {
	const url = new URL(
		`/s/${encodeURIComponent(id)}/@grant/${version}/${grant.expires}/${grant.signature}/`,
		contentOrigin
	);
	url.searchParams.set('purpose', 'thumbnail');
	url.searchParams.set('e', thumbnailGrant.expires);
	url.searchParams.set('g', thumbnailGrant.signature);
	return url;
};
