import type { RequestHandler } from './$types';
import { Effect } from 'effect';
import {
	decodeBillingWebhook,
	reconcileOrgPlan
} from '$lib/server/billing-webhook';
import { AppConfig } from '$lib/server/config';
import { runEdge } from '$lib/server/edge';
import { InvalidRequest, Unauthorized } from '$lib/server/errors';
import { PgSql } from '$lib/server/pg';
import { readBoundedText } from '$lib/server/request-json';
import { verifySvix } from '$lib/server/svix';
import { AutumnClient } from '$lib/server/services/autumn';

const MAX_PAYLOAD_BYTES = 256 * 1024;

const log = (entry: Record<string, unknown>) =>
	Effect.sync(() => {
		console.log(JSON.stringify(entry));
	});

// Autumn's verified Svix deliveries reconcile authoritative subscriptions
// into orgs.plan, which quota and trust gates read locally.
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
			const payload = yield* readBoundedText(request, {
				maxBytes: MAX_PAYLOAD_BYTES,
				invalidLengthMessage: 'Webhook payload is too large',
				invalidTextMessage: 'Webhook is invalid'
			});
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
			if (event.kind === 'reconcile') {
				const autumn = yield* AutumnClient;
				const plan = yield* reconcileOrgPlan(sql, autumn, event.orgId);
				yield* log({
					message:
						plan !== null
							? 'org plan updated from Autumn'
							: 'Autumn plan change for an unknown org',
					orgId: event.orgId,
					plan
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
