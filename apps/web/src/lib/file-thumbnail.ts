export const DASHBOARD_THUMBNAIL = {
	width: 480,
	height: 360,
	fit: 'cover',
	format: 'webp',
	quality: 75,
	anim: false,
	metadata: 'none'
} as const;

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
