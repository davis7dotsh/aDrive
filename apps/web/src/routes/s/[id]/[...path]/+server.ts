import type { RequestHandler } from './$types';
import { Effect } from 'effect';
import { matchesEtag } from '$lib/file-thumbnail';
import { shouldCountDownload } from '$lib/server/auth-policy';
import { contentSecurityPolicy } from '$lib/server/content-headers';
import {
	firstIfNoneMatchEtag,
	notModifiedResponse,
	siteCacheControl
} from '$lib/server/content-cache';
import { AppConfig } from '$lib/server/config';
import { runEdge } from '$lib/server/edge';
import { NotFound } from '$lib/server/errors';
import { isSiteVersionRequestServable } from '$lib/server/site-policy';
import { Blobs } from '$lib/server/services/blobs';
import { Files } from '$lib/server/services/files';
import { Sites } from '$lib/server/services/sites';
import { GrantSecrets } from '$lib/server/services/grant-secrets';

export const trailingSlash = 'ignore';

const siteGrant = (path: string) => {
	const [marker, versionValue, expiresValue, signature, ...assetPath] =
		path.split('/');
	if (marker !== '@grant') return null;
	const version = Number(versionValue);
	const expiresAtSeconds = Number(expiresValue);
	if (
		!Number.isSafeInteger(version) ||
		version < 1 ||
		!Number.isSafeInteger(expiresAtSeconds) ||
		expiresAtSeconds < 1 ||
		!/^[A-Za-z0-9_-]{43}$/.test(signature ?? '')
	) {
		return false;
	}
	return {
		version,
		expiresAtSeconds,
		signature: signature ?? '',
		assetPath: assetPath.join('/')
	};
};

const serveSite: RequestHandler = ({ params, request, url }) =>
	runEdge(
		Effect.gen(function* () {
			const grant = siteGrant(params.path ?? '');
			if (grant === false) return yield* new NotFound({ id: params.id });
			const hasGrant = grant !== null;
			const thumbnailSource = url.searchParams.get('purpose') === 'thumbnail';
			if (thumbnailSource && !hasGrant) {
				return yield* new NotFound({ id: params.id });
			}
			if (
				!hasGrant &&
				!isSiteVersionRequestServable(url.searchParams.get('v'))
			) {
				return yield* new NotFound({ id: params.id });
			}
			const sites = yield* Sites;
			const blobs = yield* Blobs;
			const files = yield* Files;
			const config = yield* AppConfig;
			if (grant) {
				const grantSecrets = yield* GrantSecrets;
				const granted = yield* grantSecrets.verify({
					contentOrigin: config.contentOrigin,
					requestOrigin: url.origin,
					fileId: params.id,
					version: grant.version,
					expiresAtSeconds: grant.expiresAtSeconds,
					signature: grant.signature
				});
				if (!granted) return yield* new NotFound({ id: params.id });
				if (thumbnailSource) {
					const thumbnailGranted = yield* grantSecrets.verify({
						contentOrigin: config.contentOrigin,
						requestOrigin: url.origin,
						fileId: params.id,
						version: grant.version,
						expiresAtSeconds: Number(url.searchParams.get('e')),
						signature: url.searchParams.get('g') ?? '',
						purpose: 'thumbnail-source'
					});
					if (!thumbnailGranted) return yield* new NotFound({ id: params.id });
				}
			}
			const asset = yield* sites.findAsset(
				params.id,
				grant ? grant.assetPath : (params.path ?? ''),
				{
					includeUnavailable: hasGrant,
					version: grant?.version
				}
			);
			const cacheControl = siteCacheControl(hasGrant, asset.contentType);
			const ifNoneMatch = request.headers.get('if-none-match');
			const headersFor = (etag: string, size: number) => ({
				'Cache-Control': cacheControl,
				'Content-Length': String(size),
				'Content-Security-Policy': contentSecurityPolicy(
					asset.contentType,
					config.dashboardOrigin
				),
				'Content-Type': asset.contentType,
				ETag: etag,
				'Referrer-Policy': 'no-referrer',
				'X-Content-Type-Options': 'nosniff'
			});

			if (request.method === 'HEAD') {
				const object = yield* blobs.head(asset.r2Key);
				if (!hasGrant && matchesEtag(ifNoneMatch, object.httpEtag)) {
					return notModifiedResponse(object.httpEtag, cacheControl);
				}
				return new Response(null, {
					headers: headersFor(object.httpEtag, object.size)
				});
			}

			const conditionalEtag = hasGrant
				? null
				: firstIfNoneMatchEtag(ifNoneMatch);
			const countHtmlDownload =
				asset.contentType === 'text/html' &&
				!thumbnailSource &&
				shouldCountDownload(request.headers.get('range'));

			if (conditionalEtag === '*') {
				const object = yield* blobs.head(asset.r2Key);
				if (countHtmlDownload) yield* files.recordDownload(params.id);
				return notModifiedResponse(object.httpEtag, cacheControl);
			}

			const loaded =
				conditionalEtag === null
					? {
							changed: true as const,
							object: yield* blobs.get(asset.r2Key)
						}
					: yield* blobs.getIfChanged(asset.r2Key, conditionalEtag);
			if (!loaded.changed) {
				if (countHtmlDownload) yield* files.recordDownload(params.id);
				return notModifiedResponse(loaded.object.httpEtag, cacheControl);
			}
			if (!hasGrant && matchesEtag(ifNoneMatch, loaded.object.httpEtag)) {
				if (countHtmlDownload) yield* files.recordDownload(params.id);
				return notModifiedResponse(loaded.object.httpEtag, cacheControl);
			}

			const object = loaded.object;
			if (countHtmlDownload) {
				yield* files.recordDownload(params.id);
			}
			return new Response(object.body, {
				headers: headersFor(object.httpEtag, object.size)
			});
		})
	);

export const GET = serveSite;
export const HEAD = serveSite;
