import type { RequestHandler } from './$types';
import { Effect } from 'effect';
import { AppConfig } from '$lib/server/config';
import { runEdge } from '$lib/server/edge';
import { Auth } from '$lib/server/services/auth';
import { Search } from '$lib/server/services/search';
import { Tags } from '$lib/server/services/tags';

export const GET: RequestHandler = ({ request, url }) =>
	runEdge(
		Effect.gen(function* () {
			const auth = yield* Auth;
			const search = yield* Search;
			const tags = yield* Tags;
			const config = yield* AppConfig;
			yield* auth.authorize({
				authorization: request.headers.get('authorization'),
				requestOrigin: url.origin
			});
			return Response.json({
				files: yield* search.files({
					query: url.searchParams.get('q') ?? '',
					tagIds: url.searchParams.getAll('tag').slice(0, 20)
				}),
				tags: yield* tags.list,
				contentOrigin: config.contentOrigin,
				maxUploadBytes: config.maxUploadBytes
			});
		})
	);
