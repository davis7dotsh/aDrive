import { normalizeSitePath } from '@adrive/shared';

export interface GallerySource {
	readonly displayName: string;
	readonly contentType: string;
	readonly sizeBytes: number;
}

export interface GalleryAsset extends GallerySource {
	readonly path: string;
}

const UNSAFE = /[\u0000-\u001f\u007f-\u009f\\/]/gu;

// Turn a file's display name into a safe, unique site asset path. Falls back to
// a stable slug when the name normalizes to something the site path rules
// reject, and disambiguates collisions by inserting a counter before the
// extension.
export const siteAssetPathFor = (
	displayName: string,
	taken: ReadonlySet<string>,
	fallback: string
) => {
	const cleaned = displayName.normalize('NFKC').replace(UNSAFE, '_').trim();
	let base: string;
	try {
		base = cleaned.length > 0 ? normalizeSitePath(cleaned) : `${fallback}`;
	} catch {
		base = fallback;
	}
	if (base === '.' || base === '..') base = fallback;
	if (!taken.has(base)) return base;
	const dot = base.lastIndexOf('.');
	const stem = dot > 0 ? base.slice(0, dot) : base;
	const ext = dot > 0 ? base.slice(dot) : '';
	for (let index = 2; ; index += 1) {
		const candidate = `${stem}-${index}${ext}`;
		if (!taken.has(candidate)) return candidate;
	}
};

const escapeHtml = (value: string) =>
	value
		.replaceAll('&', '&amp;')
		.replaceAll('<', '&lt;')
		.replaceAll('>', '&gt;')
		.replaceAll('"', '&quot;')
		.replaceAll("'", '&#39;');

// A path is served relative to /s/<id>/; encode each segment so names with
// spaces or other characters resolve.
const encodePath = (path: string) =>
	path
		.split('/')
		.map((segment) => encodeURIComponent(segment))
		.join('/');

const formatBytes = (bytes: number) => {
	if (bytes < 1024) return `${bytes} B`;
	const units = ['KB', 'MB', 'GB', 'TB'];
	let value = bytes / 1024;
	let unit = 0;
	while (value >= 1024 && unit < units.length - 1) {
		value /= 1024;
		unit += 1;
	}
	return `${value.toFixed(value >= 10 ? 0 : 1)} ${units[unit]}`;
};

// Build a self-contained index.html for a set of drive files published as a
// site. Images render as a gallery grid; anything else is listed with a link.
// No external assets or scripts, locked down by the same CSP as other site
// HTML.
export const renderSiteIndex = (
	title: string,
	assets: ReadonlyArray<GalleryAsset>
) => {
	const images = assets.filter((asset) =>
		asset.contentType.startsWith('image/')
	);
	const others = assets.filter(
		(asset) => !asset.contentType.startsWith('image/')
	);
	const gallery =
		images.length > 0
			? `<div class="grid">${images
					.map(
						(asset) =>
							`<a class="tile" href="${escapeHtml(encodePath(asset.path))}"><img loading="lazy" src="${escapeHtml(encodePath(asset.path))}" alt="${escapeHtml(asset.displayName)}" /><span>${escapeHtml(asset.displayName)}</span></a>`
					)
					.join('')}</div>`
			: '';
	const list =
		others.length > 0
			? `<ul class="files">${others
					.map(
						(asset) =>
							`<li><a href="${escapeHtml(encodePath(asset.path))}">${escapeHtml(asset.displayName)}</a> <span class="meta">${escapeHtml(formatBytes(asset.sizeBytes))}</span></li>`
					)
					.join('')}</ul>`
			: '';
	return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${escapeHtml(title)}</title>
<style>
	body { font: 16px/1.5 system-ui, sans-serif; margin: 0; background: #fff; color: #18181b; }
	main { max-width: 60rem; margin: 0 auto; padding: 2rem 1.25rem 4rem; }
	h1 { font-size: 1.4rem; margin: 0 0 1.5rem; }
	.grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(10rem, 1fr)); gap: 0.75rem; }
	.tile { display: block; text-decoration: none; color: inherit; }
	.tile img { width: 100%; aspect-ratio: 1 / 1; object-fit: cover; border-radius: 0.5rem; border: 1px solid #e4e4e7; background: #fafafa; }
	.tile span { display: block; margin-top: 0.35rem; font-size: 0.8rem; color: #52525b; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
	.files { list-style: none; padding: 0; margin: 1.5rem 0 0; }
	.files li { padding: 0.5rem 0; border-top: 1px solid #f4f4f5; }
	.files a { color: #18181b; }
	.meta { color: #a1a1aa; font-size: 0.8rem; margin-left: 0.5rem; }
</style>
</head>
<body>
<main>
<h1>${escapeHtml(title)}</h1>
${gallery}
${list}
</main>
</body>
</html>`;
};
