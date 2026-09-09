import type { RequestHandler } from './$types';
import { Effect, Schema } from 'effect';
import { runEdge } from '$lib/server/edge';
import { decodeJson } from '$lib/server/request-json';
import { requireAdmin } from '$lib/server/request-auth';
import { Admin } from '$lib/server/services/admin';

const Body = Schema.Struct({
	verdict: Schema.Literals(['clean', 'malicious'])
});

// An operator's verdict on a held or quarantined file.
export const PATCH: RequestHandler = (event) =>
	runEdge(
		Effect.gen(function* () {
			const admin = yield* Admin;
			yield* requireAdmin(event);
			const { verdict } = yield* decodeJson(
				event.request,
				Body,
				'A verdict (clean, malicious) is required'
			);
			yield* admin.markFile(event.params.id, verdict);
			return Response.json({ ok: true as const });
		})
	);
