import type { RequestHandler } from './$types';
import { Effect } from 'effect';
import { runEdge } from '$lib/server/edge';
import { requireWrite } from '$lib/server/request-auth';
import { InvalidRequest } from '$lib/server/errors';
import { Sites } from '$lib/server/services/sites';

export const PUT: RequestHandler = (event) => {
	const { params, request, url } = event;
	return runEdge(
		Effect.gen(function* () {
			const sites = yield* Sites;
			yield* requireWrite(event);
			const path = url.searchParams.get('path');
			if (path === null) {
				return yield* new InvalidRequest({
					status: 400,
					message: 'Site asset path is required'
				});
			}
			return Response.json(
				yield* sites.stageAsset({
					sessionId: params.id,
					path,
					contentLength: request.headers.get('content-length'),
					body: request.body
				}),
				{ status: 201 }
			);
		})
	);
};
