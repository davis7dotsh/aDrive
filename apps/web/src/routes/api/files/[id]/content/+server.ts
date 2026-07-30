import type { RequestHandler } from './$types';
import { Effect } from 'effect';
import {
	contentLinkRedirectResponse,
	resolveFileContentLink
} from '$lib/server/file-content-link';
import { runEdge } from '$lib/server/edge';
import { Auth, authorizeRequest } from '$lib/server/services/auth';

const requestedVersion = (url: URL) => {
	const value = url.searchParams.get('v');
	return value === null ? undefined : Number(value);
};

export const GET: RequestHandler = ({ cookies, params, request, url }) =>
	runEdge(
		Effect.gen(function* () {
			const auth = yield* Auth;
			yield* authorizeRequest(auth, request, url, cookies);
			return contentLinkRedirectResponse(
				yield* resolveFileContentLink(params.id, requestedVersion(url))
			);
		})
	);
