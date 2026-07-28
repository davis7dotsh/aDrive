import type { RequestHandler } from './$types';
import { Effect } from 'effect';
import { AppConfig } from '$lib/server/config';
import { verifyScheduledRequest } from '$lib/server/cron-auth';
import { runEdge } from '$lib/server/edge';
import { Unauthorized } from '$lib/server/errors';
import { Lifecycle } from '$lib/server/services/lifecycle';

export const POST: RequestHandler = ({ request }) =>
	runEdge(
		Effect.gen(function* () {
			const config = yield* AppConfig;
			const lifecycle = yield* Lifecycle;
			const authorized = yield* Effect.tryPromise({
				try: () =>
					verifyScheduledRequest(
						config.passcode,
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
			yield* lifecycle.run;
			return new Response(null, { status: 204 });
		})
	);
