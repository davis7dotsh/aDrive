import type { RequestHandler } from './$types';
import { Effect } from 'effect';
import { runEdge } from '$lib/server/edge';
import { Auth, authorizeWriteRequest } from '$lib/server/services/auth';
import { assertFileInScope } from '$lib/server/token-scope';
import { Shares } from '$lib/server/services/shares';

export const DELETE: RequestHandler = ({ cookies, params, request, url }) =>
	runEdge(
		Effect.gen(function* () {
			const auth = yield* Auth;
			const shares = yield* Shares;
			const credential = yield* authorizeWriteRequest(
				auth,
				request,
				url,
				cookies
			);
			yield* assertFileInScope(credential, params.id);
			yield* shares.revoke(params.id, params.shareId);
			return new Response(null, { status: 204 });
		})
	);
