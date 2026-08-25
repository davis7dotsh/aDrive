import type { RequestHandler } from './$types';
import { Effect } from 'effect';
import { runEdgeWithEvent } from '$lib/server/edge';
import { InvalidRequest } from '$lib/server/errors';
import { Auth, authorizeWriteRequest } from '$lib/server/services/auth';
import { assertUnrestricted } from '$lib/server/token-scope';
import { Uploads } from '$lib/server/services/uploads';

export const PUT: RequestHandler = (event) => {
	const { cookies, params, request, url } = event;
	return runEdgeWithEvent(
		event,
		Effect.gen(function* () {
			const auth = yield* Auth;
			const uploads = yield* Uploads;
			const credential = yield* authorizeWriteRequest(
				auth,
				request,
				url,
				cookies
			);
			yield* assertUnrestricted(credential);
			const partNumber = Number(params.part);
			if (!Number.isSafeInteger(partNumber) || partNumber < 1) {
				return yield* new InvalidRequest({
					status: 400,
					message: 'Part number is invalid'
				});
			}
			return Response.json(
				yield* uploads.uploadPart({
					sessionId: params.id,
					partNumber,
					contentLength: request.headers.get('content-length'),
					body: request.body
				}),
				{ status: 201 }
			);
		})
	);
};
