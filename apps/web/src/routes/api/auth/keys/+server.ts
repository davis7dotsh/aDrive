import { ApiKeyCreateSchema } from '@adrive/shared';
import type { RequestHandler } from './$types';
import { Effect } from 'effect';
import { runEdge } from '$lib/server/edge';
import { requireWrite } from '$lib/server/request-auth';
import { decodeJson } from '$lib/server/request-json';
import { Auth } from '$lib/server/services/auth';

// Key inventory is credential-adjacent: a leaked read-only key should not
// be able to enumerate the other credentials, so listing requires write
// scope just like creation and revocation.
export const GET: RequestHandler = (event) => {
	const { request } = event;
	return runEdge(
		Effect.gen(function* () {
			const auth = yield* Auth;
			yield* requireWrite(event);
			return Response.json({ keys: yield* auth.listApiKeys });
		})
	);
};

export const POST: RequestHandler = (event) => {
	const { request } = event;
	return runEdge(
		Effect.gen(function* () {
			const auth = yield* Auth;
			yield* requireWrite(event);
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
};
