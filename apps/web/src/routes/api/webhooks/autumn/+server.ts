import type { RequestHandler } from './$types';
import { Effect } from 'effect';
import { decodeBillingWebhook, setOrgPlan } from '$lib/server/billing-webhook';
import { AppConfig } from '$lib/server/config';
import { runEdge } from '$lib/server/edge';
import { InvalidRequest, Unauthorized } from '$lib/server/errors';
import { PgSql } from '$lib/server/pg';
import { verifySvix } from '$lib/server/svix';

const MAX_PAYLOAD_BYTES = 256 * 1024;

const log = (entry: Record<string, unknown>) =>
	Effect.sync(() => {
		console.log(JSON.stringify(entry));
	});

// Autumn's Svix deliveries. Every event is logged by type; a plan list
// moves orgs.plan so the quota and trust gates read the plan locally.
export const POST: RequestHandler = ({ request }) =>
	runEdge(
		Effect.gen(function* () {
			const config = yield* AppConfig;
			const sql = yield* PgSql;
			if (!config.autumn.webhookSecret) {
				return yield* new Unauthorized({
					message: 'The Autumn webhook is not configured'
				});
			}
			const payload = yield* Effect.tryPromise({
				try: () => request.text(),
				catch: () =>
					new InvalidRequest({ status: 400, message: 'Webhook is invalid' })
			});
			if (payload.length > MAX_PAYLOAD_BYTES) {
				return yield* new InvalidRequest({
					status: 413,
					message: 'Webhook payload is too large'
				});
			}
			const verified = yield* Effect.promise(() =>
				verifySvix(
					config.autumn.webhookSecret,
					{
						id: request.headers.get('svix-id'),
						timestamp: request.headers.get('svix-timestamp'),
						signature: request.headers.get('svix-signature')
					},
					payload
				)
			);
			if (!verified.ok) {
				return yield* new Unauthorized({
					message: `Webhook signature is invalid (${verified.reason})`
				});
			}
			const body = yield* Effect.try({
				try: (): unknown => JSON.parse(payload),
				catch: () =>
					new InvalidRequest({ status: 400, message: 'Webhook is invalid' })
			});
			const event = decodeBillingWebhook(body);
			if (event.kind === 'plan') {
				const updated = yield* setOrgPlan(sql, event.orgId, event.plan);
				yield* log({
					message: updated
						? 'org plan updated from Autumn'
						: 'Autumn plan change for an unknown org',
					orgId: event.orgId,
					plan: event.plan
				});
			} else {
				yield* log({ message: 'Autumn webhook ignored', type: event.type });
			}
			return Response.json(
				{ ok: true as const },
				{ headers: { 'Cache-Control': 'private, no-store' } }
			);
		})
	);
