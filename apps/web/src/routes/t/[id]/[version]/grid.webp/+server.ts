import type { RequestHandler } from './$types';
import { Effect } from 'effect';
import {
	DASHBOARD_THUMBNAIL,
	dashboardThumbnailSourceUrl,
	isTransformedWebpResponse,
	matchesEtag,
	supportsDashboardThumbnail
} from '$lib/file-thumbnail';
import { contentSecurityPolicy } from '$lib/server/content-headers';
import {
	fileCacheControl,
	matchEdgeCache,
	notModifiedResponse,
	pathCacheRequest,
	storeEdgeCache
} from '$lib/server/content-cache';
import { AppConfig } from '$lib/server/config';
import { runEdge } from '$lib/server/edge';
import { NotFound, StorageError } from '$lib/server/errors';
import { Blobs } from '$lib/server/services/blobs';
import { Files } from '$lib/server/services/files';
import { GrantSecrets } from '$lib/server/services/grant-secrets';

const parsedVersion = (value: string) => {
	const version = Number(value);
	return Number.isSafeInteger(version) && version > 0 ? version : null;
};

const thumbnailResponse = (
	body: BodyInit | null,
	size: number,
	etag: string,
	privateResponse: boolean
) =>
	new Response(body, {
		headers: {
			'Cache-Control': fileCacheControl(privateResponse),
			'Content-Length': String(size),
			'Content-Security-Policy': contentSecurityPolicy('image/webp'),
			'Content-Type': 'image/webp',
			ETag: etag,
			'Referrer-Policy': 'no-referrer',
			'X-Content-Type-Options': 'nosniff'
		}
	});

const publicNotModified = (etag: string) =>
	notModifiedResponse(etag, fileCacheControl(false));

const publicThumbnailRedirect = (url: URL) => {
	const location = new URL(url);
	location.searchParams.delete('e');
	location.searchParams.delete('g');
	return new Response(null, {
		status: 307,
		headers: {
			'Cache-Control': 'private, no-store',
			Location: location.href
		}
	});
};

export const GET: RequestHandler = ({ params, platform, request, url }) =>
	runEdge(
		Effect.gen(function* () {
			const version = parsedVersion(params.version);
			if (version === null) return yield* new NotFound({ id: params.id });

			const config = yield* AppConfig;
			const files = yield* Files;
			const grantSecrets = yield* GrantSecrets;
			const hasGrant = url.searchParams.has('e') && url.searchParams.has('g');
			const resolved = yield* files.findContent(params.id, version).pipe(
				Effect.map((content) => ({ content, unavailable: false }) as const),
				Effect.catchTag('NotFound', () =>
					hasGrant
						? files
								.findContent(params.id, version, true)
								.pipe(
									Effect.map(
										(content) => ({ content, unavailable: true }) as const
									)
								)
						: Effect.fail(new NotFound({ id: params.id }))
				)
			);
			const { content } = resolved;
			if (!supportsDashboardThumbnail(content.file.contentType)) {
				return yield* new NotFound({ id: params.id });
			}

			const redirectPublicGrant =
				hasGrant && !resolved.unavailable && content.file.public;
			const privateResponse =
				hasGrant || resolved.unavailable || !content.file.public;
			if (!content.file.public || hasGrant) {
				const granted = yield* grantSecrets.verify({
					contentOrigin: config.contentOrigin,
					requestOrigin: url.origin,
					fileId: params.id,
					version: content.file.version,
					expiresAtSeconds: Number(url.searchParams.get('e')),
					signature: url.searchParams.get('g') ?? ''
				});
				if (!granted) return yield* new NotFound({ id: params.id });
			}

			const cacheRequest = pathCacheRequest(url);
			if (!privateResponse && !redirectPublicGrant) {
				const cachedResponse = yield* matchEdgeCache(platform, cacheRequest);
				const cachedEtag = cachedResponse?.headers.get('ETag');
				if (cachedResponse && cachedEtag) {
					if (matchesEtag(request.headers.get('if-none-match'), cachedEtag)) {
						return publicNotModified(cachedEtag);
					}
					return cachedResponse;
				}
			}

			const blobs = yield* Blobs;
			const cached =
				content.thumbnailR2Key === null
					? { found: false as const }
					: yield* blobs.get(content.thumbnailR2Key).pipe(
							Effect.map((object) => ({ found: true as const, object })),
							Effect.catchTag('NotFound', () =>
								Effect.succeed({ found: false as const })
							)
						);
			if (cached.found) {
				if (redirectPublicGrant) return publicThumbnailRedirect(url);
				if (
					!privateResponse &&
					matchesEtag(
						request.headers.get('if-none-match'),
						cached.object.httpEtag
					)
				) {
					return publicNotModified(cached.object.httpEtag);
				}
				const response = thumbnailResponse(
					cached.object.body,
					cached.object.size,
					cached.object.httpEtag,
					privateResponse
				);
				if (!privateResponse) storeEdgeCache(platform, cacheRequest, response);
				return response;
			}
			if (!hasGrant) return yield* new NotFound({ id: params.id });

			const sourceGrant = yield* grantSecrets.mint({
				contentOrigin: config.contentOrigin,
				fileId: params.id,
				version: content.file.version,
				purpose: 'thumbnail-source'
			});
			const sourceUrl = dashboardThumbnailSourceUrl(
				config.contentOrigin,
				params.id,
				content.file.version,
				{
					expires: String(sourceGrant.expiresAtSeconds),
					signature: sourceGrant.signature
				}
			);
			const bytes = yield* Effect.tryPromise({
				try: async () => {
					const response = await fetch(sourceUrl, {
						cf: { image: DASHBOARD_THUMBNAIL }
					});
					if (!response.ok) {
						throw new Error(`Image transform returned ${response.status}`);
					}
					if (
						!isTransformedWebpResponse(
							response.headers.get('content-type'),
							response.headers.get('cf-resized')
						)
					) {
						throw new Error('Image transform did not return transformed WebP');
					}
					const output = await response.arrayBuffer();
					if (output.byteLength === 0) {
						throw new Error('Image transform returned an empty response');
					}
					return output;
				},
				catch: (cause) =>
					new StorageError({ operation: 'generate dashboard thumbnail', cause })
			});
			const body = new Response(bytes).body;
			const result = yield* files.storeDashboardThumbnail(
				params.id,
				content.file.version,
				body,
				bytes.byteLength,
				content.thumbnailR2Key
			);
			if (result._tag === 'Existing') {
				if (redirectPublicGrant) return publicThumbnailRedirect(url);
				const existing = yield* blobs.get(result.r2Key);
				if (
					!privateResponse &&
					matchesEtag(request.headers.get('if-none-match'), existing.httpEtag)
				) {
					return publicNotModified(existing.httpEtag);
				}
				const response = thumbnailResponse(
					existing.body,
					existing.size,
					existing.httpEtag,
					privateResponse
				);
				if (!privateResponse) storeEdgeCache(platform, cacheRequest, response);
				return response;
			}
			const stored = result.blob;
			if (redirectPublicGrant) return publicThumbnailRedirect(url);
			if (
				!privateResponse &&
				matchesEtag(request.headers.get('if-none-match'), stored.etag)
			) {
				return publicNotModified(stored.etag);
			}

			const response = thumbnailResponse(
				bytes,
				stored.size,
				stored.etag,
				privateResponse
			);
			if (!privateResponse) storeEdgeCache(platform, cacheRequest, response);
			return response;
		})
	);
