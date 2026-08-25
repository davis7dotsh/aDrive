import type { RequestHandler } from './$types';
import { Effect } from 'effect';
import {
	contentLinkRedirectResponse,
	resolveFileContentLink
} from '$lib/server/file-content-link';
import { runEdge } from '$lib/server/edge';
import { Auth, authorizeRequest } from '$lib/server/services/auth';
import { assertFileInScope } from '$lib/server/token-scope';

const requestedVersion = (url: URL) => {
	const value = url.searchParams.get('v');
	return value === null ? undefined : Number(value);
};

export const GET: RequestHandler = ({ cookies, params, request, url }) =>
	runEdge(
		Effect.gen(function* () {
			const auth = yield* Auth;
			const credential = yield* authorizeRequest(auth, request, url, cookies);
			yield* assertFileInScope(credential, params.id);
			return contentLinkRedirectResponse(
				yield* resolveFileContentLink(
					params.id,
					requestedVersion(url),
					url.searchParams.get('unavailable') === 'true'
				)
			);
		})
	);
