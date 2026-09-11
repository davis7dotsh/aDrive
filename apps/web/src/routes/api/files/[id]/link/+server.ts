import type { RequestHandler } from './$types';
import { Effect } from 'effect';
import {
	contentLinkJsonResponse,
	resolveFileContentLink
} from '$lib/server/file-content-link';
import { InvalidRequest } from '$lib/server/errors';
import { runEdge } from '$lib/server/edge';
import { requireAuth } from '$lib/server/request-auth';

const requestedVersion = (url: URL) => {
	const value = url.searchParams.get('v');
	if (value === null) return;
	const version = Number(value);
	if (!Number.isSafeInteger(version) || version < 1) {
		throw new InvalidRequest({
			status: 400,
			message: 'Version must be a positive integer'
		});
	}
	return version;
};

export const GET: RequestHandler = (event) => {
	const { params, request, url } = event;
	return runEdge(
		Effect.gen(function* () {
			yield* requireAuth(event);
			return contentLinkJsonResponse(
				yield* resolveFileContentLink(
					params.id,
					yield* Effect.try({
						try: () => requestedVersion(url),
						catch: (cause) =>
							cause instanceof InvalidRequest
								? cause
								: new InvalidRequest({
										status: 400,
										message: 'Version is invalid'
									})
					}),
					url.searchParams.get('unavailable') === 'true',
					url.searchParams.get('grant') === 'true'
				)
			);
		})
	);
};
