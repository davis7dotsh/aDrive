import type { RequestHandler } from './$types';
import { Effect } from 'effect';
import { contentSecurityPolicy } from '$lib/server/content-headers';
import { runEdge } from '$lib/server/edge';
import { NotFound } from '$lib/server/errors';
import { isSiteVersionRequestServable } from '$lib/server/site-policy';
import { Blobs } from '$lib/server/services/blobs';
import { Sites } from '$lib/server/services/sites';

export const GET: RequestHandler = ({ params, url }) =>
	runEdge(
		Effect.gen(function* () {
			if (!isSiteVersionRequestServable(url.searchParams.get('v'))) {
				return yield* new NotFound({ id: params.id });
			}
			const sites = yield* Sites;
			const blobs = yield* Blobs;
			const asset = yield* sites.findAsset(params.id, params.path ?? '');
			const object = yield* blobs.get(asset.r2Key);
			return new Response(object.body, {
				headers: {
					'Cache-Control': 'public, max-age=0, must-revalidate',
					'Content-Length': String(object.size),
					'Content-Security-Policy': contentSecurityPolicy(asset.contentType),
					'Content-Type': asset.contentType,
					ETag: object.httpEtag,
					'Referrer-Policy': 'no-referrer',
					'X-Content-Type-Options': 'nosniff'
				}
			});
		})
	);
