import { TagUpdateSchema } from '@adrive/shared';
import type { RequestHandler } from './$types';
import { Effect } from 'effect';
import { runEdge } from '$lib/server/edge';
import { decodeJson } from '$lib/server/request-json';
import { Auth, authorizeWriteRequest } from '$lib/server/services/auth';
import { assertUnrestricted } from '$lib/server/token-scope';
import { Tags } from '$lib/server/services/tags';

const readUpdate = (request: Request) =>
	decodeJson(request, TagUpdateSchema, 'Tag update is invalid');

export const PATCH: RequestHandler = ({ cookies, params, request, url }) =>
	runEdge(
		Effect.gen(function* () {
			const auth = yield* Auth;
			const tags = yield* Tags;
			const credential = yield* authorizeWriteRequest(
				auth,
				request,
				url,
				cookies
			);
			yield* assertUnrestricted(credential);
			const tag = yield* readUpdate(request).pipe(
				Effect.flatMap((input) => tags.update(params.id, input))
			);
			return Response.json({ tag });
		})
	);

export const DELETE: RequestHandler = ({ cookies, params, request, url }) =>
	runEdge(
		Effect.gen(function* () {
			const auth = yield* Auth;
			const tags = yield* Tags;
			const credential = yield* authorizeWriteRequest(
				auth,
				request,
				url,
				cookies
			);
			yield* assertUnrestricted(credential);
			yield* tags.remove(params.id);
			return new Response(null, { status: 204 });
		})
	);
