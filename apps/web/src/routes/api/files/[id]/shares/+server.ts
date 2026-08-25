import { FileShareCreateSchema, type FileShareCreate } from '@adrive/shared';
import type { RequestHandler } from './$types';
import { Effect } from 'effect';
import { AppConfig } from '$lib/server/config';
import { runEdge } from '$lib/server/edge';
import { decodeJson } from '$lib/server/request-json';
import {
	Auth,
	authorizeRequest,
	authorizeWriteRequest
} from '$lib/server/services/auth';
import { assertFileInScope } from '$lib/server/token-scope';
import { Shares } from '$lib/server/services/shares';

const readOptions = (request: Request) =>
	request.body === null || request.headers.get('content-length') === '0'
		? Effect.succeed({} satisfies FileShareCreate)
		: decodeJson(request, FileShareCreateSchema, 'Share options are invalid');

export const GET: RequestHandler = ({ cookies, params, request, url }) =>
	runEdge(
		Effect.gen(function* () {
			const auth = yield* Auth;
			const shares = yield* Shares;
			const config = yield* AppConfig;
			const credential = yield* authorizeRequest(auth, request, url, cookies);
			yield* assertFileInScope(credential, params.id);
			return Response.json(
				{
					shares: yield* shares.list(params.id),
					contentOrigin: config.contentOrigin
				},
				{ headers: { 'Cache-Control': 'private, no-store' } }
			);
		})
	);

export const POST: RequestHandler = ({ cookies, params, request, url }) =>
	runEdge(
		Effect.gen(function* () {
			const auth = yield* Auth;
			const shares = yield* Shares;
			const credential = yield* authorizeWriteRequest(
				auth,
				request,
				url,
				cookies
			);
			yield* assertFileInScope(credential, params.id);
			const input = yield* readOptions(request);
			const created = yield* shares.create(params.id, input);
			return Response.json(
				{ share: created.share, url: created.url },
				{
					status: 201,
					headers: { 'Cache-Control': 'private, no-store' }
				}
			);
		})
	);
