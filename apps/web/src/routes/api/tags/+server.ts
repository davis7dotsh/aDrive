import { TagCreateSchema } from '@adrive/shared';
import type { RequestHandler } from './$types';
import { Effect } from 'effect';
import { runEdge } from '$lib/server/edge';
import { requireAuth, requireWrite } from '$lib/server/request-auth';
import { decodeJson } from '$lib/server/request-json';
import { Tags } from '$lib/server/services/tags';

const readCreate = (request: Request) =>
	decodeJson(request, TagCreateSchema, 'Tag input is invalid');

export const GET: RequestHandler = (event) => {
	const { request } = event;
	return runEdge(
		Effect.gen(function* () {
			const tags = yield* Tags;
			yield* requireAuth(event);
			return Response.json({ tags: yield* tags.list });
		})
	);
};

export const POST: RequestHandler = (event) => {
	const { request } = event;
	return runEdge(
		Effect.gen(function* () {
			const tags = yield* Tags;
			yield* requireWrite(event);
			const tag = yield* readCreate(request).pipe(
				Effect.flatMap((input) => tags.create(input))
			);
			return Response.json({ tag }, { status: 201 });
		})
	);
};
