import { TagUpdateSchema } from '@adrive/shared';
import type { RequestHandler } from './$types';
import { Effect, Schema } from 'effect';
import { runEdge } from '$lib/server/edge';
import { InvalidRequest } from '$lib/server/errors';
import { Auth, authorizeRequest } from '$lib/server/services/auth';
import { Tags } from '$lib/server/services/tags';

const readUpdate = (request: Request) =>
	Effect.tryPromise({
		try: () => request.json(),
		catch: () =>
			new InvalidRequest({
				status: 400,
				message: 'A JSON request body is required'
			})
	}).pipe(
		Effect.flatMap(Schema.decodeUnknownEffect(TagUpdateSchema)),
		Effect.mapError((cause) =>
			cause instanceof InvalidRequest
				? cause
				: new InvalidRequest({
						status: 400,
						message: 'Tag update is invalid'
					})
		)
	);

export const PATCH: RequestHandler = ({ params, request, url }) =>
	runEdge(
		Effect.gen(function* () {
			const auth = yield* Auth;
			const tags = yield* Tags;
			yield* authorizeRequest(auth, request, url);
			const tag = yield* readUpdate(request).pipe(
				Effect.flatMap((input) => tags.update(params.id, input))
			);
			return Response.json({ tag });
		})
	);

export const DELETE: RequestHandler = ({ params, request, url }) =>
	runEdge(
		Effect.gen(function* () {
			const auth = yield* Auth;
			const tags = yield* Tags;
			yield* authorizeRequest(auth, request, url);
			yield* tags.remove(params.id);
			return new Response(null, { status: 204 });
		})
	);
