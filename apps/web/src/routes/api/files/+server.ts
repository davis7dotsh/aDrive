import type { RequestHandler } from './$types';
import { Effect } from 'effect';
import { runEdge } from '$lib/server/edge';
import { AppConfig } from '$lib/server/config';
import { InvalidRequest } from '$lib/server/errors';
import { Auth } from '$lib/server/services/auth';
import { Files } from '$lib/server/services/files';

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

export const PUT: RequestHandler = ({ request, url }) =>
	runEdge(
		Effect.gen(function* () {
			const auth = yield* Auth;
			const files = yield* Files;
			const config = yield* AppConfig;
			yield* auth.authorize({
				authorization: request.headers.get('authorization'),
				requestOrigin: url.origin
			});
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
				body: request.body
			});
			return Response.json(
				{
					file: result.file,
					url: `${config.contentOrigin}/f/${result.file.id}`,
					forcedPublic: result.forcedPublic
				},
				{ status: 201 }
			);
		})
	);
