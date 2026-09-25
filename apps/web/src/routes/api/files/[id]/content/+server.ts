import type { RequestHandler } from './$types';
import { Effect } from 'effect';
import {
	contentLinkRedirectResponse,
	resolveFileContentLink
} from '$lib/server/file-content-link';
import { runEdge } from '$lib/server/edge';
import { requireAuth } from '$lib/server/request-auth';

const requestedVersion = (url: URL) => {
	const value = url.searchParams.get('v');
	return value === null ? undefined : Number(value);
};

export const GET: RequestHandler = (event) => {
	const { params, request, url } = event;
	return runEdge(
		Effect.gen(function* () {
			yield* requireAuth(event);
			return contentLinkRedirectResponse(
				yield* resolveFileContentLink(
					params.id,
					requestedVersion(url),
					url.searchParams.get('unavailable') === 'true'
				)
			);
		})
	);
};
