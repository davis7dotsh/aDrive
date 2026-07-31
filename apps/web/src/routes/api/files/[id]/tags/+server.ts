import { FileTagsUpdateSchema } from '@adrive/shared';
import type { RequestHandler } from './$types';
import { Effect } from 'effect';
import { runEdge } from '$lib/server/edge';
import { decodeJson } from '$lib/server/request-json';
import { Auth, authorizeRequest } from '$lib/server/services/auth';
import { Files } from '$lib/server/services/files';
import { Tags } from '$lib/server/services/tags';

const readNames = (request: Request) =>
	decodeJson(request, FileTagsUpdateSchema, 'File tags are invalid');

export const PUT: RequestHandler = ({ cookies, params, request, url }) =>
	runEdge(
		Effect.gen(function* () {
			const auth = yield* Auth;
			const tags = yield* Tags;
			const files = yield* Files;
			yield* authorizeRequest(auth, request, url, cookies);
			const input = yield* readNames(request);
			yield* tags.setFileTags(params.id, input.names);
			return Response.json({ file: (yield* files.detail(params.id)).file });
		})
	);
