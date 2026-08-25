import type { RequestHandler } from './$types';
import { Effect } from 'effect';
import {
	DASHBOARD_RENDERED_THUMBNAIL,
	DASHBOARD_THUMBNAIL,
	dashboardRenderedThumbnailRequestPattern,
	dashboardSiteThumbnailSourceUrl,
	dashboardThumbnailSourceUrl,
	isTransformedWebpResponse,
	isWebpContentType,
	matchesEtag,
	supportsDashboardThumbnail,
	supportsRenderedDashboardThumbnail
} from '$lib/file-thumbnail';
import { contentSecurityPolicy } from '$lib/server/content-headers';
import {
	matchEdgeCache,
	notModifiedResponse,
	pathCacheRequest,
	storeEdgeCache,
	thumbnailCacheControl
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
	cacheControl: string
) =>
	new Response(body, {
		headers: {
			'Cache-Control': cacheControl,
			'Content-Length': String(size),
			'Content-Security-Policy': contentSecurityPolicy('image/webp'),
			'Content-Type': 'image/webp',
			ETag: etag,
			'Referrer-Policy': 'no-referrer',
			'X-Content-Type-Options': 'nosniff'
		}
	});

const thumbnailNotModified = (etag: string, cacheControl: string) =>
	notModifiedResponse(etag, cacheControl);

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
			const expiresAtSeconds = Number(url.searchParams.get('e'));
			const hasGrant = url.searchParams.has('e') && url.searchParams.has('g');
			const resolved = yield* files
				.findContent(params.id, version, false, true)
				.pipe(
					Effect.map((content) => ({ content, unavailable: false }) as const),
					Effect.catchTag('NotFound', () =>
						hasGrant
							? files
									.findContent(params.id, version, true, true)
									.pipe(
										Effect.map(
											(content) => ({ content, unavailable: true }) as const
										)
									)
							: Effect.fail(new NotFound({ id: params.id }))
					)
				);
			const { content } = resolved;
			const rendered = supportsRenderedDashboardThumbnail(
				content.file.kind,
				content.file.contentType
			);
			if (!rendered && !supportsDashboardThumbnail(content.file.contentType)) {
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
					expiresAtSeconds,
					signature: url.searchParams.get('g') ?? ''
				});
				if (!granted) return yield* new NotFound({ id: params.id });
			}
			const cacheControl = thumbnailCacheControl(
				privateResponse,
				expiresAtSeconds
			);

			const cacheRequest = pathCacheRequest(url);
			if (!privateResponse && !redirectPublicGrant) {
				const cachedResponse = yield* matchEdgeCache(platform, cacheRequest);
				const cachedEtag = cachedResponse?.headers.get('ETag');
				if (cachedResponse && cachedEtag) {
					if (matchesEtag(request.headers.get('if-none-match'), cachedEtag)) {
						return thumbnailNotModified(cachedEtag, cacheControl);
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
					matchesEtag(
						request.headers.get('if-none-match'),
						cached.object.httpEtag
					)
				) {
					return thumbnailNotModified(cached.object.httpEtag, cacheControl);
				}
				const response = thumbnailResponse(
					cached.object.body,
					cached.object.size,
					cached.object.httpEtag,
					cacheControl
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
			const siteGrant =
				content.file.kind === 'site'
					? yield* grantSecrets.mint({
							contentOrigin: config.contentOrigin,
							fileId: params.id,
							version: content.file.version
						})
					: null;
			const sourceUrl = siteGrant
				? dashboardSiteThumbnailSourceUrl(
						config.contentOrigin,
						params.id,
						content.file.version,
						{
							expires: String(siteGrant.expiresAtSeconds),
							signature: siteGrant.signature
						},
						{
							expires: String(sourceGrant.expiresAtSeconds),
							signature: sourceGrant.signature
						}
					)
				: dashboardThumbnailSourceUrl(
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
					const response = rendered
						? await platform?.env.BROWSER.quickAction('screenshot', {
								url: sourceUrl.href,
								...DASHBOARD_RENDERED_THUMBNAIL,
								allowRequestPattern: [
									dashboardRenderedThumbnailRequestPattern(config.contentOrigin)
								]
							})
						: await fetch(sourceUrl, {
								cf: { image: DASHBOARD_THUMBNAIL }
							});
					if (!response) {
						throw new Error('Browser rendering binding is unavailable');
					}
					if (!response.ok) {
						throw new Error(
							`${rendered ? 'Screenshot' : 'Image transform'} returned ${response.status}`
						);
					}
					if (
						rendered
							? !isWebpContentType(response.headers.get('content-type'))
							: !isTransformedWebpResponse(
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
					matchesEtag(request.headers.get('if-none-match'), existing.httpEtag)
				) {
					return thumbnailNotModified(existing.httpEtag, cacheControl);
				}
				const response = thumbnailResponse(
					existing.body,
					existing.size,
					existing.httpEtag,
					cacheControl
				);
				if (!privateResponse) storeEdgeCache(platform, cacheRequest, response);
				return response;
			}
			const stored = result.blob;
			if (redirectPublicGrant) return publicThumbnailRedirect(url);
			if (matchesEtag(request.headers.get('if-none-match'), stored.etag)) {
				return thumbnailNotModified(stored.etag, cacheControl);
			}

			const response = thumbnailResponse(
				bytes,
				stored.size,
				stored.etag,
				cacheControl
			);
			if (!privateResponse) storeEdgeCache(platform, cacheRequest, response);
			return response;
		})
	);
