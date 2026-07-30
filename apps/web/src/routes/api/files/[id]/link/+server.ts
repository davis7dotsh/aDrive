import type { RequestHandler } from './$types';
import { Effect } from 'effect';
import {
	contentLinkJsonResponse,
	resolveFileContentLink
} from '$lib/server/file-content-link';
import { InvalidRequest } from '$lib/server/errors';
import { runEdge } from '$lib/server/edge';
import { Auth, authorizeRequest } from '$lib/server/services/auth';

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

export const GET: RequestHandler = ({ cookies, params, request, url }) =>
	runEdge(
		Effect.gen(function* () {
			const auth = yield* Auth;
			yield* authorizeRequest(auth, request, url, cookies);
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
					url.searchParams.get('unavailable') === 'true'
				)
			);
		})
	);
