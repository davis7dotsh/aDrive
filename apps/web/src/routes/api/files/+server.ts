import type { RequestHandler } from './$types';
import { Effect } from 'effect';
import { runEdge, runEdgeWithEvent, runWorkerProgram } from '$lib/server/edge';
import { AppConfig } from '$lib/server/config';
import { validateExpiration } from '$lib/server/auth-policy';
import { authRateLimitResponse } from '$lib/server/auth-rate-limit-response';
import { InvalidRequest } from '$lib/server/errors';
import {
	Auth,
	authorizeRequest,
	authorizeWriteRequest
} from '$lib/server/services/auth';
import { AuthGuard } from '$lib/server/services/auth-guard';
import { Files } from '$lib/server/services/files';
import { Indexing } from '$lib/server/services/indexing';
import { Tags } from '$lib/server/services/tags';

const decodeName = (value: string | null) => {
	if (value === null) {
		throw new InvalidRequest({
			status: 400,
			message: 'X-Adrive-File-Name is required'
		});
	}
	try {
		return decodeURIComponent(value);
	} catch {
		throw new InvalidRequest({
			status: 400,
			message: 'X-Adrive-File-Name is invalid'
		});
	}
};

const parsePublic = (value: string | null) => {
	if (value === null || value === 'true') return true;
	if (value === 'false') return false;
	throw new InvalidRequest({
		status: 400,
		message: 'X-Adrive-Public must be true or false'
	});
};

const parseTags = (value: string | null) => {
	if (value === null || value === '') return [];
	if (value.length > 32768) {
		throw new InvalidRequest({
			status: 400,
			message: 'X-Adrive-Tags is too large'
		});
	}
	try {
		const parsed: unknown = JSON.parse(decodeURIComponent(value));
		if (
			!Array.isArray(parsed) ||
			!parsed.every((tag): tag is string => typeof tag === 'string')
		) {
			throw new Error('Tags must be strings');
		}
		return parsed;
	} catch {
		throw new InvalidRequest({
			status: 400,
			message: 'X-Adrive-Tags must be a JSON array of names'
		});
	}
};

export const GET: RequestHandler = ({ cookies, request, url }) =>
	runEdge(
		Effect.gen(function* () {
			const auth = yield* Auth;
			const files = yield* Files;
			const tags = yield* Tags;
			const indexing = yield* Indexing;
			const config = yield* AppConfig;
			yield* authorizeRequest(auth, request, url, cookies);
			const trashed = url.searchParams.get('trashed') === 'true';
			return Response.json({
				files: yield* files.list(trashed),
				tags: yield* tags.list,
				contentOrigin: config.contentOrigin,
				maxUploadBytes: config.maxUploadBytes,
				semantic: yield* indexing.status
			});
		})
	);

export const PUT: RequestHandler = async (event) => {
	const { cookies, request, url } = event;
	const output = await runEdgeWithEvent(
		event,
		Effect.gen(function* () {
			const auth = yield* Auth;
			const authGuard = yield* AuthGuard;
			const files = yield* Files;
			const config = yield* AppConfig;
			const credential = yield* authorizeWriteRequest(
				auth,
				request,
				url,
				cookies
			);
			const rateLimit = yield* authGuard.consume(
				'upload',
				credential.credentialId
			);
			if (!rateLimit.allowed) {
				return {
					fileId: null,
					response: authRateLimitResponse(rateLimit)
				};
			}
			const displayName = yield* Effect.try({
				try: () => decodeName(request.headers.get('x-adrive-file-name')),
				catch: (cause) =>
					cause instanceof InvalidRequest
						? cause
						: new InvalidRequest({
								status: 400,
								message: 'File name is invalid'
							})
			});
			const isPublic = yield* Effect.try({
				try: () => parsePublic(request.headers.get('x-adrive-public')),
				catch: (cause) =>
					cause instanceof InvalidRequest
						? cause
						: new InvalidRequest({
								status: 400,
								message: 'Visibility is invalid'
							})
			});
			const result = yield* files.upload({
				displayName,
				contentType:
					request.headers.get('content-type') ?? 'application/octet-stream',
				public: isPublic,
				contentLength: request.headers.get('content-length'),
				body: request.body,
				tags: yield* Effect.try({
					try: () => parseTags(request.headers.get('x-adrive-tags')),
					catch: (cause) =>
						cause instanceof InvalidRequest
							? cause
							: new InvalidRequest({
									status: 400,
									message: 'Tags are invalid'
								})
				}),
				expiresAt: yield* Effect.try({
					try: () =>
						validateExpiration(request.headers.get('x-adrive-expires-at')),
					catch: (cause) =>
						cause instanceof InvalidRequest
							? cause
							: new InvalidRequest({
									status: 400,
									message: 'Expiration is invalid'
								})
				})
			});
			return {
				fileId: result.file.id,
				response: Response.json(
					{
						file: result.file,
						url: `${config.contentOrigin}/f/${result.file.id}`,
						forcedPublic: result.forcedPublic
					},
					{ status: 201 }
				)
			};
		})
	);
	const uploadedFileId = output.fileId;
	if (uploadedFileId !== null && event.platform) {
		event.platform.ctx.waitUntil(
			runWorkerProgram(
				event.platform.env,
				Effect.gen(function* () {
					const indexing = yield* Indexing;
					yield* indexing.process(uploadedFileId);
				})
			)
		);
	}
	return output.response;
};

export const DELETE: RequestHandler = async (event) => {
	const { cookies, request, url } = event;
	const output = await runEdgeWithEvent(
		event,
		Effect.gen(function* () {
			const auth = yield* Auth;
			const files = yield* Files;
			yield* authorizeWriteRequest(auth, request, url, cookies);
			if (url.searchParams.get('trashed') !== 'true') {
				return yield* new InvalidRequest({
					status: 400,
					message: 'Only trash can be emptied'
				});
			}
			return {
				count: yield* files.scheduleAllPurgesNow,
				response: Response.json({ ok: true as const })
			};
		})
	);
	if (output.count > 0 && event.platform) {
		event.platform.ctx.waitUntil(
			runWorkerProgram(
				event.platform.env,
				Effect.gen(function* () {
					const files = yield* Files;
					yield* files.sweepPurges(10);
				})
			)
		);
	}
	return output.response;
};
