import { Effect } from 'effect';

export const PRIVATE_CACHE_CONTROL = 'private, no-store';
export const PUBLIC_IMMUTABLE_CACHE_CONTROL =
	'public, max-age=31536000, immutable';
export const PUBLIC_REVALIDATE_CACHE_CONTROL =
	'public, max-age=0, must-revalidate';
export const PUBLIC_SITE_ASSET_CACHE_CONTROL =
	'public, max-age=120, stale-while-revalidate=600, must-revalidate';
export const EDGE_CACHE_MAX_BYTES = 512 * 1024;

export const fileCacheControl = (
	privateResponse: boolean,
	pinnedVersion = true
) => {
	if (privateResponse) return PRIVATE_CACHE_CONTROL;
	return pinnedVersion
		? PUBLIC_IMMUTABLE_CACHE_CONTROL
		: PUBLIC_REVALIDATE_CACHE_CONTROL;
};

// Private thumbnail URLs include the grant (`e`/`g`). Keep those responses
// fresh only until that grant expires so a later request hits verification
// instead of the browser disk cache.
export const thumbnailCacheControl = (
	privateResponse: boolean,
	expiresAtSeconds?: number,
	nowMs = Date.now()
) => {
	if (!privateResponse) return PUBLIC_IMMUTABLE_CACHE_CONTROL;
	if (expiresAtSeconds === undefined || !Number.isFinite(expiresAtSeconds)) {
		return 'private, max-age=0, must-revalidate';
	}
	const remaining = Math.max(0, Math.floor(expiresAtSeconds - nowMs / 1_000));
	return `private, max-age=${remaining}, must-revalidate`;
};

export const siteCacheControl = (
	privateResponse: boolean,
	contentType: string
) => {
	if (privateResponse) return PRIVATE_CACHE_CONTROL;
	const type = contentType.split(';', 1)[0]?.trim().toLowerCase();
	return type === 'text/html'
		? PUBLIC_REVALIDATE_CACHE_CONTROL
		: PUBLIC_SITE_ASSET_CACHE_CONTROL;
};

export const notModifiedResponse = (etag: string, cacheControl: string) =>
	new Response(null, {
		status: 304,
		headers: {
			'Cache-Control': cacheControl,
			ETag: etag
		}
	});

export const firstIfNoneMatchEtag = (header: string | null) => {
	if (header === null) return null;
	const trimmed = header.trim();
	if (trimmed === '*') return '*';
	const candidate = trimmed.split(',')[0]?.trim();
	if (!candidate) return null;
	return candidate.replace(/^W\//, '');
};

export const isR2ObjectBody = (
	object: R2Object | R2ObjectBody
): object is R2ObjectBody =>
	'arrayBuffer' in object && typeof object.arrayBuffer === 'function';

export const fileContentCacheRequest = (url: URL) => {
	const key = new URL(url.pathname, url.origin);
	const version = url.searchParams.get('v');
	if (version) key.searchParams.set('v', version);
	if (url.searchParams.get('preview') === 'dashboard') {
		key.searchParams.set('preview', 'dashboard');
	}
	return new Request(key, { method: 'GET' });
};

export const pathCacheRequest = (url: URL) =>
	new Request(new URL(url.pathname, url.origin), { method: 'GET' });

export const canUseEdgeCache = (
	privateResponse: boolean,
	range: string | null,
	sizeBytes: number,
	pinnedVersion = true
) =>
	pinnedVersion &&
	!privateResponse &&
	range === null &&
	Number.isSafeInteger(sizeBytes) &&
	sizeBytes >= 0 &&
	sizeBytes <= EDGE_CACHE_MAX_BYTES;

interface WorkerCache {
	match(request: RequestInfo): Promise<Response | undefined>;
	put(request: RequestInfo, response: Response): Promise<void>;
}

type EdgePlatform =
	| {
			readonly caches?: unknown;
			readonly ctx?: { waitUntil(promise: Promise<unknown>): void };
	  }
	| undefined;

const workerCache = (platform: EdgePlatform) => {
	const caches = platform?.caches as { default?: WorkerCache } | undefined;
	return caches?.default;
};

export const matchEdgeCache = (platform: EdgePlatform, cacheRequest: Request) =>
	Effect.promise(async () => {
		try {
			const cached = await workerCache(platform)?.match(cacheRequest);
			// The Workers Cache API returns responses with immutable headers, but
			// hooks.server.ts applies security headers to every response. Hand back
			// a reconstructed, mutable copy so those writes don't throw.
			return cached && new Response(cached.body, cached);
		} catch {
			return undefined;
		}
	});

export const storeEdgeCache = (
	platform: EdgePlatform,
	cacheRequest: Request,
	response: Response
) => {
	const cache = workerCache(platform);
	const ctx = platform?.ctx;
	if (!cache || !ctx || response.status !== 200) return;
	ctx.waitUntil(cache.put(cacheRequest, response.clone()).catch(() => {}));
};
