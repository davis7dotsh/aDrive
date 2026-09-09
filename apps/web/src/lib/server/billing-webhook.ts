import type { PgClient } from '@effect/sql-pg';
import { Effect } from 'effect';
import { StorageError } from './errors';
import { type Plan, isPlan } from './plans';

// What an Autumn webhook asks the app to do. Every event is logged by
// type; only a plan list (billing.updated's plan_changes) moves
// orgs.plan, which the trust and quota gates read without an API call.
export type BillingWebhookEvent =
	| { readonly kind: 'plan'; readonly orgId: string; readonly plan: Plan }
	| { readonly kind: 'ignored'; readonly type: string };

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === 'object' && value !== null && !Array.isArray(value);

const text = (value: unknown) => (typeof value === 'string' ? value : '');

// Plans in effect after the change: activated or updated entries whose
// subscription is not expired. A scheduled plan is not yet in effect and
// an expired one no longer is. The best known plan wins; none means the
// org is back on free.
const PLAN_RANK: ReadonlyArray<Plan> = ['pro', 'free'];

const ENDED = new Set(['expired', 'canceled', 'scheduled']);

const effectivePlans = (changes: ReadonlyArray<unknown>) =>
	changes.flatMap((change) => {
		if (!isRecord(change)) return [];
		const action = text(change.action);
		if (action === 'expired' || action === 'scheduled') return [];
		const subject = isRecord(change.subscription)
			? change.subscription
			: isRecord(change.purchase)
				? change.purchase
				: null;
		if (subject === null) return [];
		if (ENDED.has(text(subject.status))) return [];
		const planId = text(subject.plan_id);
		return isPlan(planId) ? [planId] : [];
	});

export const decodeBillingWebhook = (payload: unknown): BillingWebhookEvent => {
	if (!isRecord(payload)) return { kind: 'ignored', type: '' };
	const type = text(payload.type);
	const data = isRecord(payload.data) ? payload.data : null;
	const orgId = data ? text(data.customer_id) : '';
	const changes =
		data && Array.isArray(data.plan_changes) ? data.plan_changes : null;
	// Entity-scoped plans belong to a sub-entity, not the org.
	if (!orgId || changes === null || (data && text(data.entity_id))) {
		return { kind: 'ignored', type };
	}
	const effective = effectivePlans(changes);
	const plan = PLAN_RANK.find((candidate) => effective.includes(candidate));
	return { kind: 'plan', orgId, plan: plan ?? 'free' };
};

// Resolves to whether an org row was updated (a customer id that names no
// org is acknowledged and dropped).
export const setOrgPlan = (sql: PgClient.PgClient, orgId: string, plan: Plan) =>
	sql<{ id: string }>`
		UPDATE orgs SET plan = ${plan} WHERE id = ${orgId} RETURNING id`.pipe(
		Effect.map((rows) => rows.length === 1),
		Effect.mapError(
			(cause) => new StorageError({ operation: 'update org plan', cause })
		)
	);
