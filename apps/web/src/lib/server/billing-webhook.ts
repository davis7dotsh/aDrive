import type { PgClient } from '@effect/sql-pg';
import { Effect } from 'effect';
import { StorageError } from './errors';
import type { AutumnClientShape } from './services/autumn';

// plan_changes contains only affected plans, not the complete subscription
// state. A verified customer-level event asks us to reconcile from Autumn.
export type BillingWebhookEvent =
	| { readonly kind: 'reconcile'; readonly orgId: string }
	| { readonly kind: 'ignored'; readonly type: string };

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === 'object' && value !== null && !Array.isArray(value);

const text = (value: unknown) => (typeof value === 'string' ? value : '');

export const decodeBillingWebhook = (payload: unknown): BillingWebhookEvent => {
	if (!isRecord(payload)) return { kind: 'ignored', type: '' };
	const type = text(payload.type);
	const data = isRecord(payload.data) ? payload.data : null;
	const orgId = data ? text(data.customer_id) : '';
	if (type !== 'billing.updated' || !orgId || !data || text(data.entity_id)) {
		return { kind: 'ignored', type };
	}
	return { kind: 'reconcile', orgId };
};

// Lock before the provider read, so concurrent/redelivered signals cannot
// finish an older read after a newer one and restore a stale local plan.
// Unknown customers are acknowledged without creating an Autumn customer.
export const reconcileOrgPlan = (
	sql: PgClient.PgClient,
	autumn: AutumnClientShape,
	orgId: string
) =>
	sql
		.withTransaction(
			Effect.gen(function* () {
				const rows = yield* sql<{ id: string }>`
		SELECT id FROM orgs WHERE id = ${orgId} FOR UPDATE`;
				if (rows.length === 0) return null;
				const plan = yield* autumn.getPlan({ customerId: orgId });
				yield* sql`UPDATE orgs SET plan = ${plan} WHERE id = ${orgId}`;
				return plan;
			})
		)
		.pipe(
			Effect.mapError((cause) =>
				cause instanceof StorageError
					? cause
					: new StorageError({ operation: 'reconcile org plan', cause })
			)
		);
