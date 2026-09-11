import type { RequestHandler } from './$types';
import { Effect, Schema } from 'effect';
import { runEdge } from '$lib/server/edge';
import { decodeJson } from '$lib/server/request-json';
import { requireAdmin } from '$lib/server/request-auth';
import { Admin } from '$lib/server/services/admin';

const Body = Schema.Struct({
	verdict: Schema.Literals(['clean', 'malicious']),
	version: Schema.Int
});

// An operator's verdict on a held or quarantined file.
export const PATCH: RequestHandler = (event) =>
	runEdge(
		Effect.gen(function* () {
			const admin = yield* Admin;
			const auth = yield* requireAdmin(event);
			const { verdict, version } = yield* decodeJson(
				event.request,
				Body,
				'A verdict (clean, malicious) is required'
			);
			yield* admin.markFile(event.params.id, version, verdict, auth.userId);
			return Response.json({ ok: true as const });
		})
	);
