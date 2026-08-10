export const DASHBOARD_THUMBNAIL = {
	width: 480,
	height: 360,
	fit: 'cover',
	format: 'webp',
	quality: 75,
	anim: false,
	metadata: 'none'
} as const;

export const dashboardThumbnailKey = (id: string, version: number) =>
	`thumbnail/${id}/${version}/grid.webp`;

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
