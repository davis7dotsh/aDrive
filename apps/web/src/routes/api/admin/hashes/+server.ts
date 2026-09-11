import type { RequestHandler } from './$types';
import { Effect, Schema } from 'effect';
import { runEdge } from '$lib/server/edge';
import { decodeJson } from '$lib/server/request-json';
import { requireAdmin } from '$lib/server/request-auth';
import { Admin } from '$lib/server/services/admin';

const Body = Schema.Struct({
	sha256: Schema.String,
	reason: Schema.optionalKey(Schema.String)
});

// Appends to blocked_hashes; the scanner quarantines any upload that
// matches from then on.
export const POST: RequestHandler = (event) =>
	runEdge(
		Effect.gen(function* () {
			const admin = yield* Admin;
			const auth = yield* requireAdmin(event);
			const body = yield* decodeJson(
				event.request,
				Body,
				'A sha256 is required'
			);
			yield* admin.blockHash(body.sha256, body.reason ?? '', auth.userId);
			return Response.json({ ok: true as const }, { status: 201 });
		})
	);
