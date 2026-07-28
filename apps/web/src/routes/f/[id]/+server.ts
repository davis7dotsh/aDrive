import type { RequestHandler } from './$types';
import { Effect } from 'effect';
import {
	contentDisposition,
	contentSecurityPolicy
} from '$lib/server/content-headers';
import { AppConfig } from '$lib/server/config';
import { shouldCountDownload } from '$lib/server/auth-policy';
import { decodeRangeHeader, rangeHeaders } from '$lib/server/download-response';
import { runEdge } from '$lib/server/edge';
import { NotFound } from '$lib/server/errors';
import { Blobs } from '$lib/server/services/blobs';
import { Files } from '$lib/server/services/files';
import { GrantSecrets } from '$lib/server/services/grant-secrets';

const requestedVersion = (url: URL) => {
	const value = url.searchParams.get('v');
	if (value === null) return;
	const version = Number(value);
	return Number.isSafeInteger(version) && version > 0 ? version : null;
};

export const GET: RequestHandler = ({ params, request, url }) =>
	runEdge(
		Effect.gen(function* () {
			const config = yield* AppConfig;
			const files = yield* Files;
			const grantSecrets = yield* GrantSecrets;
			const version = requestedVersion(url);
			if (version === null) return yield* new NotFound({ id: params.id });
			const content = yield* files.findContent(params.id, version);
			if (!content.file.public) {
				const expiresAtSeconds = Number(url.searchParams.get('e'));
				const signature = url.searchParams.get('g') ?? '';
				const granted = yield* grantSecrets.verify({
					contentOrigin: config.contentOrigin,
					requestOrigin: url.origin,
					fileId: params.id,
					version: content.file.version,
					expiresAtSeconds,
					signature
				});
				if (!granted) return yield* new NotFound({ id: params.id });
			}
			const blobs = yield* Blobs;
			const range = yield* decodeRangeHeader(request.headers.get('range'));
			const object = yield* blobs.get(content.r2Key, range);
			const responseRange = rangeHeaders(object, content.file.sizeBytes);
			if (shouldCountDownload(range)) {
				yield* files.recordDownload(content.file.id);
			}

			return new Response(object.body, {
				status: responseRange.status,
				headers: {
					'Accept-Ranges': 'bytes',
					'Content-Disposition': contentDisposition(
						content.file.displayName,
						content.file.contentType,
						!content.file.public
					),
					'Content-Length': String(responseRange.contentLength),
					'Content-Security-Policy': contentSecurityPolicy(
						content.file.contentType
					),
					'Content-Type': content.file.contentType,
					ETag: object.httpEtag,
					...(responseRange.contentRange
						? { 'Content-Range': responseRange.contentRange }
						: {}),
					...(content.file.public
						? {}
						: { 'Cache-Control': 'private, no-store' }),
					'Referrer-Policy': 'no-referrer',
					'X-Content-Type-Options': 'nosniff'
				}
			});
		})
	);
