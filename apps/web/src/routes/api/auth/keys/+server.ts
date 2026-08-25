import { ApiKeyCreateSchema } from '@adrive/shared';
import type { RequestHandler } from './$types';
import { Effect } from 'effect';
import { runEdge } from '$lib/server/edge';
import { decodeJson } from '$lib/server/request-json';
import { Auth, authorizeWriteRequest } from '$lib/server/services/auth';
import { assertUnrestricted } from '$lib/server/token-scope';

// Key inventory is credential-adjacent: a leaked read-only key should not
// be able to enumerate the other credentials, so listing requires write
// scope just like creation and revocation. Scoped tokens never manage keys.
export const GET: RequestHandler = ({ cookies, request, url }) =>
	runEdge(
		Effect.gen(function* () {
			const auth = yield* Auth;
			const credential = yield* authorizeWriteRequest(
				auth,
				request,
				url,
				cookies
			);
			yield* assertUnrestricted(
				credential,
				'This token is scoped and cannot manage API keys. Use a full-drive key.'
			);
			return Response.json({ keys: yield* auth.listApiKeys });
		})
	);

export const POST: RequestHandler = ({ cookies, request, url }) =>
	runEdge(
		Effect.gen(function* () {
			const auth = yield* Auth;
			const credential = yield* authorizeWriteRequest(
				auth,
				request,
				url,
				cookies
			);
			yield* assertUnrestricted(
				credential,
				'This token is scoped and cannot manage API keys. Use a full-drive key.'
			);
			const input = yield* decodeJson(
				request,
				ApiKeyCreateSchema,
				'An API key name is required'
			);
			return Response.json(
				yield* auth.createApiKey(input.name, {
					scope: input.scope,
					expiresAt: input.expiresAt ?? null,
					allowedTagIds: input.allowedTagIds ?? null,
					allowedFileIds: input.allowedFileIds ?? null
				}),
				{
					status: 201
				}
			);
		})
	);
