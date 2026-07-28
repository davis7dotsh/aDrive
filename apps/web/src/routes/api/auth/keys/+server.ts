import { ApiKeyCreateSchema } from '@adrive/shared';
import type { RequestHandler } from './$types';
import { Effect } from 'effect';
import { runEdge } from '$lib/server/edge';
import { decodeJson } from '$lib/server/request-json';
import { Auth, authorizeRequest } from '$lib/server/services/auth';

export const GET: RequestHandler = ({ request, url }) =>
	runEdge(
		Effect.gen(function* () {
			const auth = yield* Auth;
			yield* authorizeRequest(auth, request, url);
			return Response.json({ keys: yield* auth.listApiKeys });
		})
	);

export const POST: RequestHandler = ({ request, url }) =>
	runEdge(
		Effect.gen(function* () {
			const auth = yield* Auth;
			yield* authorizeRequest(auth, request, url);
			const input = yield* decodeJson(
				request,
				ApiKeyCreateSchema,
				'An API key name is required'
			);
			return Response.json(yield* auth.createApiKey(input.name), {
				status: 201
			});
		})
	);
