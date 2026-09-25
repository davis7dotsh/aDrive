import { DeviceApprovalSchema } from '@adrive/shared';
import type { RequestHandler } from './$types';
import { Effect } from 'effect';
import { runEdge } from '$lib/server/edge';
import { requireWrite } from '$lib/server/request-auth';
import { decodeJson } from '$lib/server/request-json';
import { Auth } from '$lib/server/services/auth';

export const POST: RequestHandler = (event) => {
	const { request } = event;
	return runEdge(
		Effect.gen(function* () {
			const auth = yield* Auth;
			yield* requireWrite(event);
			const input = yield* decodeJson(
				request,
				DeviceApprovalSchema,
				'A device approval code is required'
			);
			yield* auth.approveDevice(input.userCode);
			return Response.json({ ok: true as const });
		})
	);
};

export const DELETE: RequestHandler = (event) => {
	const { request } = event;
	return runEdge(
		Effect.gen(function* () {
			const auth = yield* Auth;
			yield* requireWrite(event);
			const input = yield* decodeJson(
				request,
				DeviceApprovalSchema,
				'A device approval code is required'
			);
			yield* auth.denyDevice(input.userCode);
			return Response.json({ ok: true as const });
		})
	);
};
