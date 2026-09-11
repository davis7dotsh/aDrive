import type { RequestHandler } from './$types';
import { Effect, Schema } from 'effect';
import { runEdge } from '$lib/server/edge';
import { RESOLUTIONS } from '$lib/server/report-policy';
import { decodeJson } from '$lib/server/request-json';
import { requireAdmin } from '$lib/server/request-auth';
import { Admin } from '$lib/server/services/admin';

const Body = Schema.Struct({ resolution: Schema.Literals(RESOLUTIONS) });

export const PATCH: RequestHandler = (event) =>
	runEdge(
		Effect.gen(function* () {
			const admin = yield* Admin;
			yield* requireAdmin(event);
			const { resolution } = yield* decodeJson(
				event.request,
				Body,
				`A resolution (${RESOLUTIONS.join(', ')}) is required`
			);
			yield* admin.resolveReport(event.params.id, resolution);
			return Response.json({ ok: true as const });
		})
	);
