import {
	SiteSessionCreateSchema,
	type SiteSessionCreate
} from '@adrive/shared';
import type { RequestHandler } from './$types';
import { Effect, Schema } from 'effect';
import { runEdge } from '$lib/server/edge';
import { InvalidRequest } from '$lib/server/errors';
import { readBoundedJson } from '$lib/server/request-json';
import { Auth, authorizeWriteRequest } from '$lib/server/services/auth';
import { Sites } from '$lib/server/services/sites';

const MAX_MANIFEST_BYTES = 1024 * 1024;

const readManifest = (request: Request) =>
	Effect.gen(function* () {
		const value = yield* readBoundedJson(request, {
			maxBytes: MAX_MANIFEST_BYTES,
			invalidLengthMessage: 'Site manifest length is invalid',
			invalidJsonMessage: 'A JSON site manifest is required'
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
			yield* authorizeWriteRequest(auth, request, url, cookies);
			const input: SiteSessionCreate = yield* readManifest(request);
			return Response.json(yield* sites.createSession(input), { status: 201 });
		})
	);
