import { OrgUpdateSchema } from '@adrive/shared';
import type { RequestHandler } from './$types';
import { Effect } from 'effect';
import { runEdge } from '$lib/server/edge';
import { InvalidRequest } from '$lib/server/errors';
import { requireAuth, requireWrite } from '$lib/server/request-auth';
import { decodeJson } from '$lib/server/request-json';
import { Org } from '$lib/server/services/org';

export const GET: RequestHandler = (event) => {
	const { request } = event;
	return runEdge(
		Effect.gen(function* () {
			const org = yield* Org;
			yield* requireAuth(event);
			return Response.json(yield* org.settings);
		})
	);
};

// Renaming the content host moves every published link, so only an
// owner with a write credential may do it.
export const PATCH: RequestHandler = (event) => {
	const { request } = event;
	return runEdge(
		Effect.gen(function* () {
			const org = yield* Org;
			const auth = yield* requireWrite(event);
			if (auth.role !== 'owner') {
				return yield* new InvalidRequest({
					status: 403,
					message: 'Only an owner can change the slug'
				});
			}
			const input = yield* decodeJson(
				request,
				OrgUpdateSchema,
				'A slug is required'
			);
			return Response.json(yield* org.changeSlug(input.slug));
		})
	);
};
