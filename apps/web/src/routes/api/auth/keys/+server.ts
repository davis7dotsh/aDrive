import { ApiKeyCreateSchema } from '@adrive/shared';
import type { RequestHandler } from './$types';
import { Effect } from 'effect';
import { runEdge } from '$lib/server/edge';
import { decodeJson } from '$lib/server/request-json';
import {
	Auth,
	authorizeRequest,
	authorizeWriteRequest
} from '$lib/server/services/auth';

export const GET: RequestHandler = ({ cookies, request, url }) =>
	runEdge(
		Effect.gen(function* () {
			const auth = yield* Auth;
			yield* authorizeRequest(auth, request, url, cookies);
			return Response.json({ keys: yield* auth.listApiKeys });
		})
	);

export const POST: RequestHandler = ({ cookies, request, url }) =>
	runEdge(
		Effect.gen(function* () {
			const auth = yield* Auth;
			yield* authorizeWriteRequest(auth, request, url, cookies);
			const input = yield* decodeJson(
				request,
				ApiKeyCreateSchema,
				'An API key name is required'
			);
			return Response.json(
				yield* auth.createApiKey(input.name, {
					scope: input.scope,
					expiresAt: input.expiresAt ?? null
				}),
				{
					status: 201
				}
			);
		})
	);
