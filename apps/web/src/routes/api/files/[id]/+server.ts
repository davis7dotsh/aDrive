import { FileMutationSchema } from '@adrive/shared';
import type { RequestHandler } from './$types';
import { Effect } from 'effect';
import { runEdge, runEdgeWithEvent, runWorkerProgram } from '$lib/server/edge';
import { AppConfig } from '$lib/server/config';
import { validateExpiration } from '$lib/server/auth-policy';
import { InvalidRequest } from '$lib/server/errors';
import { decodeJson } from '$lib/server/request-json';
import { parsePageSize } from '$lib/server/list-cursor';
import {
	Auth,
	authorizeRequest,
	authorizeWriteRequest
} from '$lib/server/services/auth';
import { Files } from '$lib/server/services/files';
import { Tags } from '$lib/server/services/tags';
import { Indexing } from '$lib/server/services/indexing';
import { assertFileInScope } from '$lib/server/token-scope';

const readMutation = (request: Request) =>
	decodeJson(request, FileMutationSchema, 'File mutation is invalid');

export const GET: RequestHandler = ({ cookies, params, request, url }) =>
	runEdge(
		Effect.gen(function* () {
			const auth = yield* Auth;
			const files = yield* Files;
			const tags = yield* Tags;
			const indexing = yield* Indexing;
			const config = yield* AppConfig;
			const credential = yield* authorizeRequest(auth, request, url, cookies);
			yield* assertFileInScope(credential, params.id);
			// File detail, tag list, and indexing status are independent D1
			// reads; run them concurrently like the list and search routes.
			const [detail, tagList, semantic] = yield* Effect.all(
				[
					files.detail(params.id, {
						cursor: url.searchParams.get('versionsCursor'),
						limit: yield* Effect.try({
							try: () =>
								parsePageSize(url.searchParams.get('versionsLimit'), 50, 200),
							catch: (cause) =>
								cause instanceof InvalidRequest
									? cause
									: new InvalidRequest({
											status: 400,
											message: 'Page size is invalid'
										})
						})
					}),
					tags.list,
					indexing.status
				],
				{ concurrency: 'unbounded' }
			);
			return Response.json({
				...detail,
				availableTags: tagList,
				contentOrigin: config.contentOrigin,
				maxUploadBytes: config.maxUploadBytes,
				semanticEnabled: semantic.enabled
			});
		})
	);

export const PATCH: RequestHandler = async (event) => {
	const { cookies, params, request, url } = event;
	const output = await runEdgeWithEvent(
		event,
		Effect.gen(function* () {
			const auth = yield* Auth;
			const files = yield* Files;
			const indexing = yield* Indexing;
			const credential = yield* authorizeWriteRequest(
				auth,
				request,
				url,
				cookies
			);
			yield* assertFileInScope(credential, params.id);
			const mutation = yield* readMutation(request);
			const result =
				mutation.action === 'visibility'
					? yield* files.setVisibility(params.id, mutation.public)
					: mutation.action === 'trash'
						? yield* files.trash(params.id)
						: mutation.action === 'restore'
							? yield* files.restore(params.id)
							: mutation.action === 'expiration'
								? yield* files.setExpiration(
										params.id,
										yield* Effect.try({
											try: () => validateExpiration(mutation.expiresAt),
											catch: (cause) =>
												cause instanceof InvalidRequest
													? cause
													: new InvalidRequest({
															status: 400,
															message: 'Expiration is invalid'
														})
										})
									)
								: mutation.action === 'rename'
									? yield* files.rename(params.id, mutation.displayName)
									: mutation.action === 'restore-version'
										? yield* files.restoreVersion(params.id, mutation.version)
										: mutation.action === 'purge'
											? yield* files.schedulePurgeNow(params.id)
											: yield* indexing.enqueue(params.id).pipe(
													Effect.andThen(files.detail(params.id)),
													Effect.map((detail) => ({
														file: detail.file,
														forcedPublic: false
													}))
												);
			return {
				reindex:
					mutation.action === 'reindex' ||
					mutation.action === 'rename' ||
					mutation.action === 'restore-version',
				purge: mutation.action === 'purge',
				response: Response.json(result)
			};
		})
	);
	if (output.reindex && event.platform) {
		event.platform.ctx.waitUntil(
			runWorkerProgram(
				event.platform.env,
				Effect.gen(function* () {
					const indexing = yield* Indexing;
					yield* indexing.process(params.id);
				})
			)
		);
	}
	if (output.purge && event.platform) {
		event.platform.ctx.waitUntil(
			runWorkerProgram(
				event.platform.env,
				Effect.gen(function* () {
					const files = yield* Files;
					yield* files.sweepPurges(1);
				})
			)
		);
	}
	return output.response;
};
