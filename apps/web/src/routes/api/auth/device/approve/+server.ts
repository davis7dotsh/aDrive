import { DeviceApprovalSchema } from '@adrive/shared';
import type { RequestHandler } from './$types';
import { Effect } from 'effect';
import { runEdge } from '$lib/server/edge';
import { decodeJson } from '$lib/server/request-json';
import { Auth, authorizeWriteRequest } from '$lib/server/services/auth';

export const POST: RequestHandler = ({ cookies, request, url }) =>
	runEdge(
		Effect.gen(function* () {
			const auth = yield* Auth;
			yield* authorizeWriteRequest(auth, request, url, cookies);
			const input = yield* decodeJson(
				request,
				DeviceApprovalSchema,
				'A device approval code is required'
			);
			yield* auth.approveDevice(input.userCode);
			return Response.json({ ok: true as const });
		})
	);

export const DELETE: RequestHandler = ({ cookies, request, url }) =>
	runEdge(
		Effect.gen(function* () {
			const auth = yield* Auth;
			yield* authorizeWriteRequest(auth, request, url, cookies);
			const input = yield* decodeJson(
				request,
				DeviceApprovalSchema,
				'A device approval code is required'
			);
			yield* auth.denyDevice(input.userCode);
			return Response.json({ ok: true as const });
		})
	);
