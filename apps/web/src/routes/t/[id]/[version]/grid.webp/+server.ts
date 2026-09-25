import type { RequestHandler } from './$types';
import { dev } from '$app/environment';
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
import { rateLimitResponse } from '$lib/server/auth-rate-limit-response';
import { runEdge } from '$lib/server/edge';
import { NotFound, StorageError } from '$lib/server/errors';
import { Blobs } from '$lib/server/services/blobs';
import { currentContentOrigin } from '$lib/server/services/current-org';
import { Files } from '$lib/server/services/files';
import { GrantSecrets } from '$lib/server/services/grant-secrets';
import { RateLimits } from '$lib/server/services/rate-limits';

const parsedVersion = (value: string) => {
	const version = Number(value);
	return Number.isSafeInteger(version) && version > 0 ? version : null;
};

const thumbnailResponse = (
	body: BodyInit | null,
	size: number | undefined,
	etag: string,
	cacheControl: string,
	contentType = 'image/webp'
) =>
	new Response(body, {
		headers: {
			'Cache-Control': cacheControl,
			...(size === undefined ? {} : { 'Content-Length': String(size) }),
			'Content-Security-Policy': contentSecurityPolicy(contentType),
			'Content-Type': contentType,
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

export const GET: RequestHandler = ({
	getClientAddress,
	params,
	platform,
	request,
	url
}) =>
	runEdge(
		Effect.gen(function* () {
			const version = parsedVersion(params.version);
			if (version === null) return yield* new NotFound({ id: params.id });

			// The host names the org; sources for the renderer are fetched
			// from the same per-org origin.
			const contentOrigin = yield* currentContentOrigin;
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
					orgId: content.orgId,
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

			const rateLimits = yield* RateLimits;
			const rateLimit = yield* rateLimits.anonymous(getClientAddress());
			if (!rateLimit.allowed) return rateLimitResponse();

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
				orgId: content.orgId,
				fileId: params.id,
				version: content.file.version,
				purpose: 'thumbnail-source'
			});
			const siteGrant =
				content.file.kind === 'site'
					? yield* grantSecrets.mint({
							orgId: content.orgId,
							fileId: params.id,
							version: content.file.version
						})
					: null;
			const sourceUrl = siteGrant
				? dashboardSiteThumbnailSourceUrl(
						contentOrigin,
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
						contentOrigin,
						params.id,
						content.file.version,
						{
							expires: String(sourceGrant.expiresAtSeconds),
							signature: sourceGrant.signature
						}
					);
			// Local workerd has no image resizing, so in development an image
			// that cannot be transformed is served unresized and unstored.
			const generated = yield* Effect.tryPromise({
				try: async (): Promise<
					| { readonly kind: 'transformed'; readonly bytes: ArrayBuffer }
					| {
							readonly kind: 'unresized';
							readonly response: Response;
					  }
				> => {
					const response = rendered
						? await platform?.env.BROWSER.quickAction('screenshot', {
								url: sourceUrl.href,
								...DASHBOARD_RENDERED_THUMBNAIL,
								allowRequestPattern: [
									dashboardRenderedThumbnailRequestPattern(contentOrigin)
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
						if (dev && !rendered) {
							return {
								kind: 'unresized',
								response
							};
						}
						throw new Error('Image transform did not return transformed WebP');
					}
					const output = await response.arrayBuffer();
					if (output.byteLength === 0) {
						throw new Error('Image transform returned an empty response');
					}
					return { kind: 'transformed', bytes: output };
				},
				catch: (cause) =>
					new StorageError({ operation: 'generate dashboard thumbnail', cause })
			});
			if (generated.kind === 'unresized') {
				const { response } = generated;
				const length = response.headers.get('content-length');
				const size =
					length !== null && /^\d+$/.test(length) ? Number(length) : undefined;
				// Preserve the original stream: a grid can request several large
				// uploads concurrently. Encoded or unknown-length bodies must not
				// inherit a length that differs from the decoded stream.
				const contentLength =
					!response.headers.has('content-encoding') &&
					size !== undefined &&
					Number.isSafeInteger(size) &&
					size >= 0
						? size
						: undefined;
				return thumbnailResponse(
					response.body,
					contentLength,
					`"dev-${params.id}-${content.file.version}"`,
					'private, no-store',
					response.headers.get('content-type') ?? content.file.contentType
				);
			}
			const bytes = generated.bytes;
			const body = new Response(bytes).body;
			const result = yield* files.storeDashboardThumbnail(
				content.orgId,
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
