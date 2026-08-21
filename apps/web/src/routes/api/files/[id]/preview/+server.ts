import type { RequestHandler } from './$types';
import { Effect } from 'effect';
import { InvalidRequest } from '$lib/server/errors';
import { runEdge } from '$lib/server/edge';
import { maxPreviewBytes, previewKind } from '$lib/server/file-preview';
import { Auth, authorizeRequest } from '$lib/server/services/auth';
import { Blobs } from '$lib/server/services/blobs';
import { Files } from '$lib/server/services/files';

const requestedVersion = (url: URL) => {
	const value = url.searchParams.get('v');
	if (value === null) return;
	const version = Number(value);
	if (!Number.isSafeInteger(version) || version < 1) {
		throw new InvalidRequest({
			status: 400,
			message: 'Version must be a positive integer'
		});
	}
	return version;
};

export const GET: RequestHandler = ({ cookies, params, request, url }) =>
	runEdge(
		Effect.gen(function* () {
			const auth = yield* Auth;
			const blobs = yield* Blobs;
			const files = yield* Files;
			yield* authorizeRequest(auth, request, url, cookies);
			const version = yield* Effect.try({
				try: () => requestedVersion(url),
				catch: (cause) =>
					cause instanceof InvalidRequest
						? cause
						: new InvalidRequest({
								status: 400,
								message: 'Version is invalid'
							})
			});

			const content = yield* files.findContent(params.id, version, true);
			const kind = previewKind(
				content.file.displayName,
				content.file.contentType
			);
			if (!kind) {
				return yield* new InvalidRequest({
					status: 400,
					message: 'Preview unavailable for this file'
				});
			}
			if (content.file.sizeBytes > maxPreviewBytes) {
				return yield* new InvalidRequest({
					status: 413,
					message: 'File is too large to preview'
				});
			}

			const body = yield* blobs.readTextPrefix(content.r2Key, maxPreviewBytes);
			return new Response(body, {
				headers: {
					'Cache-Control': 'private, no-store',
					'Content-Type': 'text/plain; charset=utf-8',
					'X-Adrive-Preview-Kind': kind
				}
			});
		})
	);
