import type { RequestHandler } from './$types';
import { Effect } from 'effect';
import { runEdge } from '$lib/server/edge';
import { InvalidRequest } from '$lib/server/errors';
import { Auth, authorizeRequest } from '$lib/server/services/auth';
import { Sites } from '$lib/server/services/sites';

export const PUT: RequestHandler = ({ params, request, url }) =>
	runEdge(
		Effect.gen(function* () {
			const auth = yield* Auth;
			const sites = yield* Sites;
			yield* authorizeRequest(auth, request, url);
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
