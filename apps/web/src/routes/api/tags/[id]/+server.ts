import { TagUpdateSchema } from '@adrive/shared';
import type { RequestHandler } from './$types';
import { Effect } from 'effect';
import { runEdge } from '$lib/server/edge';
import { requireWrite } from '$lib/server/request-auth';
import { decodeJson } from '$lib/server/request-json';
import { Tags } from '$lib/server/services/tags';

const readUpdate = (request: Request) =>
	decodeJson(request, TagUpdateSchema, 'Tag update is invalid');

export const PATCH: RequestHandler = (event) => {
	const { params, request } = event;
	return runEdge(
		Effect.gen(function* () {
			const tags = yield* Tags;
			yield* requireWrite(event);
			const tag = yield* readUpdate(request).pipe(
				Effect.flatMap((input) => tags.update(params.id, input))
			);
			return Response.json({ tag });
		})
	);
};

export const DELETE: RequestHandler = (event) => {
	const { params, request } = event;
	return runEdge(
		Effect.gen(function* () {
			const tags = yield* Tags;
			yield* requireWrite(event);
			yield* tags.remove(params.id);
			return new Response(null, { status: 204 });
		})
	);
};
