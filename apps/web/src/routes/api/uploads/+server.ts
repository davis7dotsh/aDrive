import { UploadSessionCreateSchema } from '@adrive/shared';
import type { RequestHandler } from './$types';
import { Effect } from 'effect';
import { runEdge } from '$lib/server/edge';
import { authRateLimitResponse } from '$lib/server/auth-rate-limit-response';
import { decodeJson } from '$lib/server/request-json';
import { Auth, authorizeWriteRequest } from '$lib/server/services/auth';
import { assertUnrestricted } from '$lib/server/token-scope';
import { AuthGuard } from '$lib/server/services/auth-guard';
import { Uploads } from '$lib/server/services/uploads';

// Open a staged/resumable multipart upload for a file too large for the
// one-shot PUT. Returns the part size and count the client should use.
export const POST: RequestHandler = ({ cookies, request, url }) =>
	runEdge(
		Effect.gen(function* () {
			const auth = yield* Auth;
			const authGuard = yield* AuthGuard;
			const uploads = yield* Uploads;
			const credential = yield* authorizeWriteRequest(
				auth,
				request,
				url,
				cookies
			);
			yield* assertUnrestricted(credential);
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
			const input = yield* decodeJson(
				request,
				UploadSessionCreateSchema,
				'Upload session request is invalid'
			);
			return Response.json(yield* uploads.create(input), { status: 201 });
		})
	);
