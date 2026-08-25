import type { RequestHandler } from './$types';
import { Effect } from 'effect';
import { runEdge } from '$lib/server/edge';
import { Auth, authorizeWriteRequest } from '$lib/server/services/auth';
import { assertUnrestricted } from '$lib/server/token-scope';

export const DELETE: RequestHandler = ({ cookies, params, request, url }) =>
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
			yield* auth.revokeApiKey(params.id);
			return new Response(null, { status: 204 });
		})
	);
