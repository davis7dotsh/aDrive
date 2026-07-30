import type { RequestHandler } from './$types';
import { Effect } from 'effect';
import { AppConfig } from '$lib/server/config';
import { runEdge } from '$lib/server/edge';
import { Auth, authorizeRequest } from '$lib/server/services/auth';
import { Search } from '$lib/server/services/search';
import { Tags } from '$lib/server/services/tags';
import { Indexing } from '$lib/server/services/indexing';

export const GET: RequestHandler = ({ cookies, request, url }) =>
	runEdge(
		Effect.gen(function* () {
			const auth = yield* Auth;
			const search = yield* Search;
			const tags = yield* Tags;
			const indexing = yield* Indexing;
			const config = yield* AppConfig;
			yield* authorizeRequest(auth, request, url, cookies);
			return Response.json({
				files: yield* search.files({
					query: url.searchParams.get('q') ?? '',
					tagIds: url.searchParams.getAll('tag').slice(0, 20)
				}),
				tags: yield* tags.list,
				contentOrigin: config.contentOrigin,
				maxUploadBytes: config.maxUploadBytes,
				semantic: yield* indexing.status
			});
		})
	);
