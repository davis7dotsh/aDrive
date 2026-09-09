import type { RequestHandler } from './$types';
import { Effect } from 'effect';
import { runEdge } from '$lib/server/edge';
import { requireAuth, requireWrite } from '$lib/server/request-auth';
import { AppConfig } from '$lib/server/config';
import { validateExpiration } from '$lib/server/auth-policy';
import { authRateLimitResponse } from '$lib/server/auth-rate-limit-response';
import { InvalidRequest } from '$lib/server/errors';
import { parsePageSize } from '$lib/server/list-cursor';
import { AuthGuard } from '$lib/server/services/auth-guard';
import { currentContentOrigin } from '$lib/server/services/current-org';
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

export const GET: RequestHandler = (event) => {
	const { request, url } = event;
	return runEdge(
		Effect.gen(function* () {
			const files = yield* Files;
			const tags = yield* Tags;
			const indexing = yield* Indexing;
			const config = yield* AppConfig;
			yield* requireAuth(event);
			const trashed = url.searchParams.get('trashed') === 'true';
			const page = {
				cursor: url.searchParams.get('cursor'),
				limit: yield* Effect.try({
					try: () => parsePageSize(url.searchParams.get('limit'), 200, 200),
					catch: (cause) =>
						cause instanceof InvalidRequest
							? cause
							: new InvalidRequest({
									status: 400,
									message: 'Page size is invalid'
								})
				})
			};
			const omitMeta = url.searchParams.get('omitMeta') === '1';
			// The three dashboard reads (files, tags, indexing status) are
			// independent D1 queries; run them concurrently so the listing
			// latency is the slowest query, not their sum. Pagination with
			// omitMeta skips the metadata queries but still needs the listing.
			const [listing, tagList, status] = omitMeta
				? [yield* files.list(trashed, page), null, null]
				: yield* Effect.all(
						[files.list(trashed, page), tags.list, indexing.status],
						{ concurrency: 'unbounded' }
					);
			return Response.json({
				files: listing.files,
				nextCursor: listing.nextCursor,
				tags: tagList ?? [],
				contentOrigin: yield* currentContentOrigin,
				maxUploadBytes: config.maxUploadBytes,
				semantic: status ?? {
					enabled: false,
					indexedChunks: 0,
					dimensions: 384,
					model: '',
					costNotice: ''
				}
			});
		})
	);
};

export const PUT: RequestHandler = (event) => {
	const { request, url } = event;
	return runEdge(
		Effect.gen(function* () {
			const authGuard = yield* AuthGuard;
			const files = yield* Files;
			const credential = yield* requireWrite(event);
			const rateLimit = yield* authGuard.consume(
				'upload',
				credential.credentialId
			);
			if (!rateLimit.allowed) {
				return authRateLimitResponse(
					rateLimit,
					'Too many uploads. Try again later.'
				);
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
			return Response.json(
				{
					file: result.file,
					url: `${yield* currentContentOrigin}/f/${result.file.id}`,
					forcedPublic: result.forcedPublic
				},
				{ status: 201 }
			);
		})
	);
};

export const DELETE: RequestHandler = (event) => {
	const { url } = event;
	return runEdge(
		Effect.gen(function* () {
			const files = yield* Files;
			yield* requireWrite(event);
			if (url.searchParams.get('trashed') !== 'true') {
				return yield* new InvalidRequest({
					status: 400,
					message: 'Only trash can be emptied'
				});
			}
			yield* files.scheduleAllPurgesNow;
			return Response.json({ ok: true as const });
		})
	);
};
