import { FileTagsUpdateSchema } from '@adrive/shared';
import type { RequestHandler } from './$types';
import { Effect } from 'effect';
import { runEdge } from '$lib/server/edge';
import { requireWrite } from '$lib/server/request-auth';
import { decodeJson } from '$lib/server/request-json';
import { Files } from '$lib/server/services/files';
import { Tags } from '$lib/server/services/tags';

const readNames = (request: Request) =>
	decodeJson(request, FileTagsUpdateSchema, 'File tags are invalid');

export const PUT: RequestHandler = (event) => {
	const { params, request } = event;
	return runEdge(
		Effect.gen(function* () {
			const tags = yield* Tags;
			const files = yield* Files;
			yield* requireWrite(event);
			const input = yield* readNames(request);
			yield* tags.setFileTags(params.id, input.names);
			return Response.json({ file: (yield* files.detail(params.id)).file });
		})
	);
};
