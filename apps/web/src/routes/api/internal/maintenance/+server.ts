import type { RequestHandler } from './$types';
import { Effect } from 'effect';
import { AppConfig } from '$lib/server/config';
import { verifyScheduledRequest } from '$lib/server/cron-auth';
import { runAcrossOrgs, runEdgeWithEvent } from '$lib/server/edge';
import { Unauthorized } from '$lib/server/errors';
import { Lifecycle, summarize } from '$lib/server/services/lifecycle';

// The cron tick: one global pass (device codes, trust promotions), then
// one bounded pass per randomly chosen live org so no tenant starves
// another.
export const POST: RequestHandler = async (event) => {
	const { request } = event;
	const { global, trust } = await runEdgeWithEvent(
		event,
		Effect.gen(function* () {
			const config = yield* AppConfig;
			const lifecycle = yield* Lifecycle;
			const authorized = yield* Effect.tryPromise({
				try: () =>
					verifyScheduledRequest(
						config.maintenanceSecret,
						request.headers.get('x-adrive-scheduled-time'),
						request.headers.get('x-adrive-scheduled-cron'),
						request.headers.get('x-adrive-scheduled-signature')
					),
				catch: () =>
					new Unauthorized({ message: 'Scheduled request is unauthorized' })
			});
			if (!authorized) {
				return yield* new Unauthorized({
					message: 'Scheduled request is unauthorized'
				});
			}
			const global = yield* lifecycle.global;
			const trust = yield* lifecycle.trust;
			return { global, trust };
		})
	);
	if (!event.platform) return new Response(null, { status: 204 });
	const perOrg = await runAcrossOrgs(
		event.platform.env,
		Effect.flatMap(Lifecycle, (lifecycle) => lifecycle.org)
	);
	console.log(
		JSON.stringify({
			message: 'maintenance tick',
			orgs: perOrg.length,
			trustPromotions: trust,
			...summarize(
				global,
				perOrg.map((entry) => entry.value)
			)
		})
	);
	return new Response(null, { status: 204 });
};
