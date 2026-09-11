import type { RequestHandler } from './$types';
import { Effect, Schema } from 'effect';
import { runEdge } from '$lib/server/edge';
import { decodeJson } from '$lib/server/request-json';
import { requireAdmin } from '$lib/server/request-auth';
import { Admin } from '$lib/server/services/admin';

const Body = Schema.Union([
	Schema.Struct({ action: Schema.Literal('suspend') }),
	Schema.Struct({ action: Schema.Literal('restore') }),
	Schema.Struct({
		action: Schema.Literal('trust'),
		trust: Schema.Literals(['new', 'verified', 'established'])
	})
]);

export const PATCH: RequestHandler = (event) =>
	runEdge(
		Effect.gen(function* () {
			const admin = yield* Admin;
			yield* requireAdmin(event);
			const body = yield* decodeJson(
				event.request,
				Body,
				'An org action (suspend, restore, trust) is required'
			);
			const orgId = event.params.id;
			const org =
				body.action === 'suspend'
					? yield* admin.suspendOrg(orgId)
					: body.action === 'restore'
						? yield* admin.restoreOrg(orgId)
						: yield* admin.setTrust(orgId, body.trust);
			return Response.json({ org });
		})
	);
