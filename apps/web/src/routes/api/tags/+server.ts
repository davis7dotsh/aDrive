import { TagCreateSchema } from '@adrive/shared';
import type { RequestHandler } from './$types';
import { Effect, Schema } from 'effect';
import { runEdge } from '$lib/server/edge';
import { InvalidRequest } from '$lib/server/errors';
import { Auth, authorizeRequest } from '$lib/server/services/auth';
import { Tags } from '$lib/server/services/tags';

const readCreate = (request: Request) =>
	Effect.tryPromise({
		try: () => request.json(),
		catch: () =>
			new InvalidRequest({
				status: 400,
				message: 'A JSON request body is required'
			})
	}).pipe(
		Effect.flatMap(Schema.decodeUnknownEffect(TagCreateSchema)),
		Effect.mapError((cause) =>
			cause instanceof InvalidRequest
				? cause
				: new InvalidRequest({
						status: 400,
						message: 'Tag input is invalid'
					})
		)
	);

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
			yield* authorizeRequest(auth, request, url, cookies);
			const tag = yield* readCreate(request).pipe(
				Effect.flatMap((input) => tags.create(input))
			);
			return Response.json({ tag }, { status: 201 });
		})
	);
