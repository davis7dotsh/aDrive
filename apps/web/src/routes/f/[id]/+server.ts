import type { RequestHandler } from './$types';
import { Effect } from 'effect';
import {
	contentDisposition,
	contentSecurityPolicy
} from '$lib/server/content-headers';
import { runEdge } from '$lib/server/edge';
import { NotFound } from '$lib/server/errors';
import { Blobs } from '$lib/server/services/blobs';
import { Files } from '$lib/server/services/files';

const requestedVersion = (url: URL) => {
	const value = url.searchParams.get('v');
	return value === null ? undefined : Number(value);
};

export const GET: RequestHandler = ({ params, url }) =>
	runEdge(
		Effect.gen(function* () {
			const files = yield* Files;
			const blobs = yield* Blobs;
			const content = yield* files.findContent(
				params.id,
				requestedVersion(url)
			);
			if (!content.file.public) return yield* new NotFound({ id: params.id });
			const object = yield* blobs.get(content.r2Key);

			return new Response(object.body, {
				headers: {
					'Content-Disposition': contentDisposition(
						content.file.displayName,
						content.file.contentType
					),
					'Content-Length': String(object.size),
					'Content-Security-Policy': contentSecurityPolicy(
						content.file.contentType
					),
					'Content-Type': content.file.contentType,
					ETag: object.httpEtag,
					'Referrer-Policy': 'no-referrer',
					'X-Content-Type-Options': 'nosniff'
				}
			});
		})
	);
