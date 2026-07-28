import type { RequestHandler } from './$types';
import { Effect } from 'effect';
import { AppConfig } from '$lib/server/config';
import { runEdge } from '$lib/server/edge';
import { Auth, authorizeRequest } from '$lib/server/services/auth';
import { Sites } from '$lib/server/services/sites';

export const POST: RequestHandler = ({ params, request, url }) =>
	runEdge(
		Effect.gen(function* () {
			const auth = yield* Auth;
			const config = yield* AppConfig;
			const sites = yield* Sites;
			yield* authorizeRequest(auth, request, url);
			const result = yield* sites.commit(params.id);
			return Response.json(
				{
					...result,
					url: `${config.contentOrigin}/s/${result.file.id}/`
				},
				{ status: 201 }
			);
		})
	);
