import type { RequestHandler } from './$types';
import { Effect } from 'effect';
import {
	DASHBOARD_THUMBNAIL,
	dashboardThumbnailKey,
	dashboardThumbnailSourceUrl,
	supportsDashboardThumbnail
} from '$lib/file-thumbnail';
import { contentSecurityPolicy } from '$lib/server/content-headers';
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
			'Cache-Control': privateResponse
				? 'private, no-store'
				: 'public, max-age=31536000, immutable',
			'Content-Length': String(size),
			'Content-Security-Policy': contentSecurityPolicy('image/webp'),
			'Content-Type': 'image/webp',
			ETag: etag,
			'Referrer-Policy': 'no-referrer',
			'X-Content-Type-Options': 'nosniff'
		}
	});

export const GET: RequestHandler = ({ params, url }) =>
	runEdge(
		Effect.gen(function* () {
			const version = parsedVersion(params.version);
			if (version === null) return yield* new NotFound({ id: params.id });

			const config = yield* AppConfig;
			const files = yield* Files;
			const grantSecrets = yield* GrantSecrets;
			const hasGrant = url.searchParams.has('e') && url.searchParams.has('g');
			const content = yield* files.findContent(params.id, version, hasGrant);
			if (!supportsDashboardThumbnail(content.file.contentType)) {
				return yield* new NotFound({ id: params.id });
			}

			const privateResponse = hasGrant || !content.file.public;
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
			const key = dashboardThumbnailKey(params.id, content.file.version);
			const cached = yield* blobs.get(key).pipe(
				Effect.map((object) => ({ found: true as const, object })),
				Effect.catchTag('NotFound', () =>
					Effect.succeed({ found: false as const })
				)
			);
			if (cached.found) {
				return thumbnailResponse(
					cached.object.body,
					cached.object.size,
					cached.object.httpEtag,
					privateResponse
				);
			}

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
					if (response.headers.get('content-type') !== 'image/webp') {
						throw new Error('Image transform did not return WebP');
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
			const stored = yield* blobs.put(
				key,
				body,
				bytes.byteLength,
				'image/webp'
			);

			return thumbnailResponse(
				bytes,
				stored.size,
				stored.etag,
				privateResponse
			);
		})
	);
