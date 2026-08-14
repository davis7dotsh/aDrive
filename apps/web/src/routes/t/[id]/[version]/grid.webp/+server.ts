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
import { AppConfig } from '$lib/server/config';
import { runEdge } from '$lib/server/edge';
import { NotFound, StorageError } from '$lib/server/errors';
import { Blobs } from '$lib/server/services/blobs';
import { Files } from '$lib/server/services/files';
import { GrantSecrets } from '$lib/server/services/grant-secrets';

const PUBLIC_CACHE_CONTROL = 'public, max-age=0, must-revalidate';

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
			'Cache-Control': privateResponse
				? 'private, no-store'
				: PUBLIC_CACHE_CONTROL,
			'Content-Length': String(size),
			'Content-Security-Policy': contentSecurityPolicy('image/webp'),
			'Content-Type': 'image/webp',
			ETag: etag,
			'Referrer-Policy': 'no-referrer',
			'X-Content-Type-Options': 'nosniff'
		}
	});

const notModifiedResponse = (etag: string) =>
	new Response(null, {
		status: 304,
		headers: {
			'Cache-Control': PUBLIC_CACHE_CONTROL,
			ETag: etag
		}
	});

export const GET: RequestHandler = ({ params, request, url }) =>
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

			const privateResponse = resolved.unavailable || !content.file.public;
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
				if (
					!privateResponse &&
					matchesEtag(
						request.headers.get('if-none-match'),
						cached.object.httpEtag
					)
				) {
					return notModifiedResponse(cached.object.httpEtag);
				}
				return thumbnailResponse(
					cached.object.body,
					cached.object.size,
					cached.object.httpEtag,
					privateResponse
				);
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
				const existing = yield* blobs.get(result.r2Key);
				if (
					!privateResponse &&
					matchesEtag(request.headers.get('if-none-match'), existing.httpEtag)
				) {
					return notModifiedResponse(existing.httpEtag);
				}
				return thumbnailResponse(
					existing.body,
					existing.size,
					existing.httpEtag,
					privateResponse
				);
			}
			const stored = result.blob;
			if (
				!privateResponse &&
				matchesEtag(request.headers.get('if-none-match'), stored.etag)
			) {
				return notModifiedResponse(stored.etag);
			}

			return thumbnailResponse(
				bytes,
				stored.size,
				stored.etag,
				privateResponse
			);
		})
	);
