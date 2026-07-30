import {
	SiteSessionCreateSchema,
	type SiteSessionCreate
} from '@adrive/shared';
import type { RequestHandler } from './$types';
import { Effect, Schema } from 'effect';
import { runEdge } from '$lib/server/edge';
import { InvalidRequest } from '$lib/server/errors';
import { Auth, authorizeRequest } from '$lib/server/services/auth';
import { Sites } from '$lib/server/services/sites';

const MAX_MANIFEST_BYTES = 1024 * 1024;

const readManifest = (request: Request) =>
	Effect.gen(function* () {
		const contentLengthHeader = request.headers.get('content-length');
		if (contentLengthHeader === null) {
			return yield* new InvalidRequest({
				status: 411,
				message: 'Content-Length is required'
			});
		}
		const contentLength = Number(contentLengthHeader);
		if (
			!Number.isSafeInteger(contentLength) ||
			contentLength < 0 ||
			contentLength > MAX_MANIFEST_BYTES
		) {
			return yield* new InvalidRequest({
				status: contentLength > MAX_MANIFEST_BYTES ? 413 : 400,
				message: 'Site manifest length is invalid'
			});
		}
		const value = yield* Effect.tryPromise({
			try: () => request.json(),
			catch: () =>
				new InvalidRequest({
					status: 400,
					message: 'A JSON site manifest is required'
				})
		});
		return yield* Schema.decodeUnknownEffect(SiteSessionCreateSchema)(
			value
		).pipe(
			Effect.mapError(
				() =>
					new InvalidRequest({
						status: 400,
						message: 'Site manifest is invalid'
					})
			)
		);
	});

export const POST: RequestHandler = ({ cookies, request, url }) =>
	runEdge(
		Effect.gen(function* () {
			const auth = yield* Auth;
			const sites = yield* Sites;
			yield* authorizeRequest(auth, request, url, cookies);
			const input: SiteSessionCreate = yield* readManifest(request);
			return Response.json(yield* sites.createSession(input), { status: 201 });
		})
	);
