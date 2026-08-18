import { Effect } from 'effect';
import { describe, expect, it, vi } from 'vitest';
import {
	EDGE_CACHE_MAX_BYTES,
	PRIVATE_CACHE_CONTROL,
	PUBLIC_IMMUTABLE_CACHE_CONTROL,
	PUBLIC_REVALIDATE_CACHE_CONTROL,
	PUBLIC_SITE_ASSET_CACHE_CONTROL,
	canUseEdgeCache,
	fileCacheControl,
	fileContentCacheRequest,
	firstIfNoneMatchEtag,
	isR2ObjectBody,
	matchEdgeCache,
	notModifiedResponse,
	pathCacheRequest,
	siteCacheControl,
	storeEdgeCache
} from './content-cache';

describe('content cache policy', () => {
	it('makes versioned public files immutable and keeps grants private', () => {
		expect(fileCacheControl(false)).toBe(PUBLIC_IMMUTABLE_CACHE_CONTROL);
		expect(fileCacheControl(true)).toBe(PRIVATE_CACHE_CONTROL);
	});

	it('revalidates published HTML and briefly caches other site assets', () => {
		expect(siteCacheControl(false, 'text/html; charset=utf-8')).toBe(
			PUBLIC_REVALIDATE_CACHE_CONTROL
		);
		expect(siteCacheControl(false, 'text/css')).toBe(
			PUBLIC_SITE_ASSET_CACHE_CONTROL
		);
		expect(siteCacheControl(true, 'text/css')).toBe(PRIVATE_CACHE_CONTROL);
	});

	it('returns a 304 that keeps the same validator and cache policy', () => {
		const response = notModifiedResponse(
			'"abc"',
			PUBLIC_IMMUTABLE_CACHE_CONTROL
		);
		expect(response.status).toBe(304);
		expect(response.headers.get('ETag')).toBe('"abc"');
		expect(response.headers.get('Cache-Control')).toBe(
			PUBLIC_IMMUTABLE_CACHE_CONTROL
		);
	});

	it('reads the first If-None-Match validator and treats * as a wildcard', () => {
		expect(firstIfNoneMatchEtag(null)).toBeNull();
		expect(firstIfNoneMatchEtag('*')).toBe('*');
		expect(firstIfNoneMatchEtag('W/"abc", "def"')).toBe('"abc"');
		expect(firstIfNoneMatchEtag('')).toBeNull();
	});

	it('keys file cache entries on the immutable version and ignores grants', () => {
		const request = fileContentCacheRequest(
			new URL('https://files.example/f/id?v=3&e=1&g=sig&preview=dashboard')
		);
		expect(request.url).toBe('https://files.example/f/id?v=3');
		expect(
			pathCacheRequest(new URL('https://files.example/t/id/3/grid.webp?g=1'))
				.url
		).toBe('https://files.example/t/id/3/grid.webp');
	});

	it('only edge-caches small public full-object responses', () => {
		expect(canUseEdgeCache(false, null, 12)).toBe(true);
		expect(canUseEdgeCache(false, null, EDGE_CACHE_MAX_BYTES)).toBe(true);
		expect(canUseEdgeCache(false, null, EDGE_CACHE_MAX_BYTES + 1)).toBe(false);
		expect(canUseEdgeCache(true, null, 12)).toBe(false);
		expect(canUseEdgeCache(false, 'bytes=0-10', 12)).toBe(false);
	});

	it('detects an R2 object that still has a body', () => {
		expect(
			isR2ObjectBody({
				httpEtag: '"abc"',
				arrayBuffer: async () => new ArrayBuffer(0)
			} as R2ObjectBody)
		).toBe(true);
		expect(isR2ObjectBody({ httpEtag: '"abc"' } as R2Object)).toBe(false);
	});

	it('reads and stores public responses in the Workers Cache API', async () => {
		const stored = new Map<string, Response>();
		const cache = {
			match: vi.fn(async (request: Request) => stored.get(request.url)),
			put: vi.fn(async (request: Request, response: Response) => {
				stored.set(request.url, response);
			})
		};
		const pending: Promise<unknown>[] = [];
		const platform = {
			caches: { default: cache },
			ctx: {
				waitUntil: (promise: Promise<unknown>) => {
					pending.push(promise);
				}
			}
		};
		const request = new Request('https://files.example/t/id/1/grid.webp');
		await expect(
			Effect.runPromise(matchEdgeCache(platform, request))
		).resolves.toBeUndefined();

		const response = new Response('webp', {
			status: 200,
			headers: { 'Cache-Control': PUBLIC_IMMUTABLE_CACHE_CONTROL }
		});
		storeEdgeCache(platform, request, response);
		await Promise.all(pending);
		expect(cache.put).toHaveBeenCalledOnce();
		await expect(
			Effect.runPromise(matchEdgeCache(platform, request))
		).resolves.toBeInstanceOf(Response);
	});
});
