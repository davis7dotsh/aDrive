import { TagCreateSchema } from '@adrive/shared';
import type { RequestHandler } from './$types';
import { Effect } from 'effect';
import { runEdge } from '$lib/server/edge';
import { decodeJson } from '$lib/server/request-json';
import {
	Auth,
	authorizeRequest,
	authorizeWriteRequest
} from '$lib/server/services/auth';
import { Tags } from '$lib/server/services/tags';

const readCreate = (request: Request) =>
	decodeJson(request, TagCreateSchema, 'Tag input is invalid');

export const GET: RequestHandler = ({ cookies, request, url }) =>
	runEdge(
		Effect.gen(function* () {
			const auth = yield* Auth;
			const tags = yield* Tags;
			yield* authorizeRequest(auth, request, url, cookies);
			return Response.json({ tags: yield* tags.list });
		})
	);

export const POST: RequestHandler = ({ cookies, request, url }) =>
	runEdge(
		Effect.gen(function* () {
			const auth = yield* Auth;
			const tags = yield* Tags;
			yield* authorizeWriteRequest(auth, request, url, cookies);
			const tag = yield* readCreate(request).pipe(
				Effect.flatMap((input) => tags.create(input))
			);
			return Response.json({ tag }, { status: 201 });
		})
	);
