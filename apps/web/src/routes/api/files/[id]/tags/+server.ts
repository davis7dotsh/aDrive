import { FileTagsUpdateSchema } from '@adrive/shared';
import type { RequestHandler } from './$types';
import { Effect, Schema } from 'effect';
import { runEdge } from '$lib/server/edge';
import { InvalidRequest } from '$lib/server/errors';
import { Auth } from '$lib/server/services/auth';
import { Files } from '$lib/server/services/files';
import { Tags } from '$lib/server/services/tags';

const readNames = (request: Request) =>
	Effect.tryPromise({
		try: () => request.json(),
		catch: () =>
			new InvalidRequest({
				status: 400,
				message: 'A JSON request body is required'
			})
	}).pipe(
		Effect.flatMap(Schema.decodeUnknownEffect(FileTagsUpdateSchema)),
		Effect.mapError((cause) =>
			cause instanceof InvalidRequest
				? cause
				: new InvalidRequest({
						status: 400,
						message: 'File tags are invalid'
					})
		)
	);

export const PUT: RequestHandler = ({ params, request, url }) =>
	runEdge(
		Effect.gen(function* () {
			const auth = yield* Auth;
			const tags = yield* Tags;
			const files = yield* Files;
			yield* auth.authorize({
				authorization: request.headers.get('authorization'),
				requestOrigin: url.origin
			});
			const input = yield* readNames(request);
			yield* tags.setFileTags(params.id, input.names);
			return Response.json({ file: (yield* files.detail(params.id)).file });
		})
	);
