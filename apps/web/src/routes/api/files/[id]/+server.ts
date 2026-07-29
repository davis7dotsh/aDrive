import { FileMutationSchema } from '@adrive/shared';
import type { RequestHandler } from './$types';
import { Effect, Schema } from 'effect';
import { runEdge, runEdgeWithEvent, runWorkerProgram } from '$lib/server/edge';
import { AppConfig } from '$lib/server/config';
import { validateExpiration } from '$lib/server/auth-policy';
import { InvalidRequest } from '$lib/server/errors';
import { Auth, authorizeRequest } from '$lib/server/services/auth';
import { Files } from '$lib/server/services/files';
import { Tags } from '$lib/server/services/tags';
import { Indexing } from '$lib/server/services/indexing';

const decodeMutation = (value: unknown) =>
	Schema.decodeUnknownEffect(FileMutationSchema)(value).pipe(
		Effect.mapError(
			() =>
				new InvalidRequest({
					status: 400,
					message: 'File mutation is invalid'
				})
		)
	);

const readJson = (request: Request) =>
	Effect.tryPromise({
		try: () => request.json(),
		catch: () =>
			new InvalidRequest({
				status: 400,
				message: 'A JSON request body is required'
			})
	});

export const GET: RequestHandler = ({ params, request, url }) =>
	runEdge(
		Effect.gen(function* () {
			const auth = yield* Auth;
			const files = yield* Files;
			const tags = yield* Tags;
			const indexing = yield* Indexing;
			const config = yield* AppConfig;
			yield* authorizeRequest(auth, request, url);
			const detail = yield* files.detail(params.id);
			return Response.json({
				...detail,
				availableTags: yield* tags.list,
				contentOrigin: config.contentOrigin,
				maxUploadBytes: config.maxUploadBytes,
				semanticEnabled: (yield* indexing.status).enabled
			});
		})
	);

export const PATCH: RequestHandler = async (event) => {
	const { params, request, url } = event;
	const output = await runEdgeWithEvent(
		event,
		Effect.gen(function* () {
			const auth = yield* Auth;
			const files = yield* Files;
			const indexing = yield* Indexing;
			yield* authorizeRequest(auth, request, url);
			const mutation = yield* readJson(request).pipe(
				Effect.flatMap(decodeMutation)
			);
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
				reindex: mutation.action === 'reindex' || mutation.action === 'rename',
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
