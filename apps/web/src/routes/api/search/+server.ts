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
			// Run the relevance search and the small dashboard reads
			// (tags, indexing status) concurrently.
			const [page, tagList, semantic] = yield* Effect.all(
				[
					search.files({
						query: url.searchParams.get('q') ?? '',
						tagIds: url.searchParams.getAll('tag').slice(0, 20),
						cursor: url.searchParams.get('cursor')
					}),
					tags.list,
					indexing.status
				],
				{ concurrency: 'unbounded' }
			);
			return Response.json({
				files: page.files,
				nextCursor: page.nextCursor,
				tags: tagList,
				contentOrigin: config.contentOrigin,
				maxUploadBytes: config.maxUploadBytes,
				semantic
			});
		})
	);
