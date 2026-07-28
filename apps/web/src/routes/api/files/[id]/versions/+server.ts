import type { RequestHandler } from './$types';
import { Effect } from 'effect';
import { runEdge } from '$lib/server/edge';
import { Auth, authorizeRequest } from '$lib/server/services/auth';
import { Files } from '$lib/server/services/files';

export const PUT: RequestHandler = ({ params, request, url }) =>
	runEdge(
		Effect.gen(function* () {
			const auth = yield* Auth;
			const files = yield* Files;
			yield* authorizeRequest(auth, request, url);
			const result = yield* files.uploadVersion({
				id: params.id,
				contentType:
					request.headers.get('content-type') ?? 'application/octet-stream',
				contentLength: request.headers.get('content-length'),
				body: request.body
			});
			return Response.json(result, { status: 201 });
		})
	);
