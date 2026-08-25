import type { RequestHandler } from './$types';
import { Effect } from 'effect';
import { matchesEtag } from '$lib/file-thumbnail';
import {
	contentDisposition,
	contentSecurityPolicy
} from '$lib/server/content-headers';
import {
	canUseEdgeCache,
	fileCacheControl,
	fileContentCacheRequest,
	firstIfNoneMatchEtag,
	matchEdgeCache,
	notModifiedResponse,
	storeEdgeCache
} from '$lib/server/content-cache';
import { AppConfig } from '$lib/server/config';
import { shouldRecordFileDownload } from '$lib/server/auth-policy';
import { decodeRangeHeader, rangeHeaders } from '$lib/server/download-response';
import { runEdge } from '$lib/server/edge';
import { NotFound, StorageError } from '$lib/server/errors';
import { Blobs } from '$lib/server/services/blobs';
import { Files } from '$lib/server/services/files';
import type { FileContent } from '$lib/server/services/files/types';
import { GrantSecrets } from '$lib/server/services/grant-secrets';
import { Shares } from '$lib/server/services/shares';
import { sharePasswordPage } from '$lib/server/share-password-page';

const requestedVersion = (url: URL) => {
	const value = url.searchParams.get('v');
	if (value === null) return;
	const version = Number(value);
	return Number.isSafeInteger(version) && version > 0 ? version : null;
};

const serveFile: RequestHandler = ({ params, platform, request, url }) =>
	runEdge(
		Effect.gen(function* () {
			const config = yield* AppConfig;
			const files = yield* Files;

			// Resolve the content to serve and whether the response is private.
			// A durable share token (`?s=`) is a self-contained, revocable link
			// that follows the file's current version; otherwise fall back to the
			// public/versioned/HMAC-grant path used by dashboards and previews.
			const shareToken = url.searchParams.get('s');
			let content: FileContent;
			let privateResponse: boolean;
			let pinnedVersion: boolean;
			let verifiedThumbnailSource = false;
			let dashboardPreview = false;

			if (shareToken !== null) {
				const shares = yield* Shares;
				const share = yield* shares.resolve(shareToken);
				if (!share || share.fileId !== params.id) {
					return yield* new NotFound({ id: params.id });
				}
				if (share.passwordHash !== null) {
					const supplied = url.searchParams.get('p');
					const unlocked =
						supplied !== null && (yield* shares.checkPassword(share, supplied));
					if (!unlocked) {
						return sharePasswordPage(url, supplied !== null);
					}
				}
				content = yield* files.findContent(params.id);
				privateResponse = true;
				pinnedVersion = false;
			} else {
				const grantSecrets = yield* GrantSecrets;
				const version = requestedVersion(url);
				if (version === null) return yield* new NotFound({ id: params.id });
				const hasGrant = url.searchParams.has('e') && url.searchParams.has('g');
				const thumbnailSource = url.searchParams.get('purpose') === 'thumbnail';
				if (thumbnailSource && !hasGrant) {
					return yield* new NotFound({ id: params.id });
				}
				content = yield* files.findContent(params.id, version, hasGrant);
				privateResponse = hasGrant || !content.file.public;
				dashboardPreview =
					(content.file.contentType === 'application/pdf' ||
						content.file.contentType.startsWith('text/html')) &&
					url.searchParams.get('preview') === 'dashboard';
				if (!content.file.public || hasGrant) {
					const expiresAtSeconds = Number(url.searchParams.get('e'));
					const signature = url.searchParams.get('g') ?? '';
					const granted = yield* grantSecrets.verify({
						contentOrigin: config.contentOrigin,
						requestOrigin: url.origin,
						fileId: params.id,
						version: content.file.version,
						expiresAtSeconds,
						signature,
						purpose: thumbnailSource ? 'thumbnail-source' : undefined
					});
					if (!granted) return yield* new NotFound({ id: params.id });
					verifiedThumbnailSource = thumbnailSource;
				}
				pinnedVersion = version !== undefined;
			}

			const blobs = yield* Blobs;
			const range =
				request.method === 'HEAD'
					? null
					: yield* decodeRangeHeader(request.headers.get('range'));
			const cacheControl = fileCacheControl(privateResponse, pinnedVersion);
			const ifNoneMatch = request.headers.get('if-none-match');
			const cacheRequest = fileContentCacheRequest(url);
			const recordDownload = shouldRecordFileDownload(
				range,
				verifiedThumbnailSource
			);
			const headersFor = (
				etag: string,
				responseRange: {
					readonly status: number;
					readonly contentLength: number;
					readonly contentRange?: string;
				}
			) => ({
				'Accept-Ranges': 'bytes',
				'Cache-Control': cacheControl,
				'Content-Disposition': contentDisposition(
					content.file.displayName,
					content.file.contentType,
					!content.file.public && !dashboardPreview
				),
				'Content-Length': String(responseRange.contentLength),
				'Content-Security-Policy': contentSecurityPolicy(
					content.file.contentType,
					dashboardPreview ? config.dashboardOrigin : "'none'"
				),
				'Content-Type': content.file.contentType,
				ETag: etag,
				...(responseRange.contentRange
					? { 'Content-Range': responseRange.contentRange }
					: {}),
				'Referrer-Policy': 'no-referrer',
				'X-Content-Type-Options': 'nosniff'
			});

			if (
				canUseEdgeCache(
					privateResponse,
					range,
					content.file.sizeBytes,
					pinnedVersion
				)
			) {
				const cached = yield* matchEdgeCache(platform, cacheRequest);
				const cachedEtag = cached?.headers.get('ETag');
				if (cached && cachedEtag) {
					if (recordDownload) yield* files.recordDownload(content.file.id);
					if (matchesEtag(ifNoneMatch, cachedEtag)) {
						return notModifiedResponse(cachedEtag, cacheControl);
					}
					if (request.method === 'HEAD') {
						return new Response(null, {
							status: 200,
							headers: headersFor(cachedEtag, {
								status: 200,
								contentLength: content.file.sizeBytes
							})
						});
					}
					return cached;
				}
			}

			if (request.method === 'HEAD') {
				const object = yield* blobs.head(content.r2Key);
				if (!privateResponse && matchesEtag(ifNoneMatch, object.httpEtag)) {
					return notModifiedResponse(object.httpEtag, cacheControl);
				}
				return new Response(null, {
					status: 200,
					headers: headersFor(object.httpEtag, {
						status: 200,
						contentLength: object.size
					})
				});
			}

			const conditionalEtag =
				range === null && !privateResponse
					? firstIfNoneMatchEtag(ifNoneMatch)
					: null;
			if (conditionalEtag === '*') {
				const object = yield* blobs.head(content.r2Key);
				if (recordDownload) yield* files.recordDownload(content.file.id);
				return notModifiedResponse(object.httpEtag, cacheControl);
			}

			const loaded =
				conditionalEtag === null
					? {
							changed: true as const,
							object: yield* blobs.get(content.r2Key, range)
						}
					: yield* blobs.getIfChanged(content.r2Key, conditionalEtag);
			if (!loaded.changed) {
				if (recordDownload) yield* files.recordDownload(content.file.id);
				return notModifiedResponse(loaded.object.httpEtag, cacheControl);
			}
			if (
				range === null &&
				!privateResponse &&
				matchesEtag(ifNoneMatch, loaded.object.httpEtag)
			) {
				if (recordDownload) yield* files.recordDownload(content.file.id);
				return notModifiedResponse(loaded.object.httpEtag, cacheControl);
			}

			const object = loaded.object;
			const responseRange = rangeHeaders(object, content.file.sizeBytes, range);
			if (!responseRange) {
				return yield* new StorageError({
					operation: 'read file range',
					cause: 'R2 returned invalid byte range metadata'
				});
			}
			if (recordDownload) {
				yield* files.recordDownload(content.file.id);
			}

			const response = new Response(object.body, {
				status: responseRange.status,
				headers: headersFor(object.httpEtag, responseRange)
			});
			if (
				canUseEdgeCache(
					privateResponse,
					range,
					content.file.sizeBytes,
					pinnedVersion
				)
			) {
				storeEdgeCache(platform, cacheRequest, response);
			}
			return response;
		})
	);

export const GET = serveFile;
export const HEAD = serveFile;
