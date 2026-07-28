import type { RequestHandler } from './$types';
import { Effect } from 'effect';
import {
	contentDisposition,
	contentSecurityPolicy
} from '$lib/server/content-headers';
import { shouldCountDownload } from '$lib/server/auth-policy';
import { decodeRangeHeader, rangeHeaders } from '$lib/server/download-response';
import { runEdge } from '$lib/server/edge';
import { NotFound } from '$lib/server/errors';
import { Blobs } from '$lib/server/services/blobs';
import { Files } from '$lib/server/services/files';

const requestedVersion = (url: URL) => {
	const value = url.searchParams.get('v');
	return value === null ? undefined : Number(value);
};

export const GET: RequestHandler = ({ params, request, url }) =>
	runEdge(
		Effect.gen(function* () {
			const files = yield* Files;
			const blobs = yield* Blobs;
			const content = yield* files.findContent(
				params.id,
				requestedVersion(url)
			);
			if (!content.file.public) return yield* new NotFound({ id: params.id });
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
						content.file.contentType
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
					'Referrer-Policy': 'no-referrer',
					'X-Content-Type-Options': 'nosniff'
				}
			});
		})
	);
