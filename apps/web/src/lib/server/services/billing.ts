import type { BillingSummary } from '@adrive/shared';
import { Context, Effect, Layer } from 'effect';
import { AppConfig } from '../config';
import { StorageError } from '../errors';
import { STUCK_JOB_MS } from '../job-policy';
import { PgSql } from '../pg';
import { PRO_PLAN_ID, planLimits } from '../plans';
import { readOrgUsage } from '../usage';
import { AutumnClient } from './autumn';
import { CurrentOrg } from './current-org';

const PLAN_NAMES: Record<string, string> = { free: 'Free', pro: 'Pro' };

export interface BillingShape {
	readonly summary: Effect.Effect<
		Omit<BillingSummary, 'canManageBilling'>,
		StorageError
	>;
	// Hosted checkout for the pro plan; null when billing is not configured.
	readonly checkoutUrl: Effect.Effect<string | null, StorageError>;
	// The customer portal (cards, invoices, cancellation).
	readonly portalUrl: Effect.Effect<string | null, StorageError>;
	// The usage-sync job: pushes the current stored bytes to Autumn as the
	// storage balance and the current UTC month's successful AI operations.
	// Absolute snapshots are safe to retry after a lost acknowledgement.
	readonly syncUsage: Effect.Effect<void, StorageError>;
}

export class Billing extends Context.Service<Billing, BillingShape>()(
	'app/Billing'
) {}

const makeBilling = Effect.gen(function* () {
	const sql = yield* PgSql;
	const autumn = yield* AutumnClient;
	const org = yield* CurrentOrg;
	const config = yield* AppConfig;

	const billingPage = `${config.dashboardOrigin}/settings/billing`;

	const summary = Effect.gen(function* () {
		const rows = yield* sql<{ plan: string }>`
			SELECT plan FROM orgs WHERE id = ${org.id}`.pipe(
			Effect.mapError(
				(cause) => new StorageError({ operation: 'read org plan', cause })
			)
		);
		const plan = rows[0]?.plan;
		const usage = yield* readOrgUsage(sql, org.id);
		if (plan === undefined || usage === null) {
			return yield* new StorageError({
				operation: 'read billing summary',
				cause: 'The organization has no plan or usage row'
			});
		}
		const limits = planLimits(plan);
		return {
			plan,
			planName: PLAN_NAMES[plan] ?? plan,
			billingEnabled: autumn.enabled,
			storage: { used: usage.storedBytes, limit: limits.storedBytes },
			aiOps: { used: usage.aiOpsMonth, limit: limits.aiOpsPerMonth }
		} satisfies Omit<BillingSummary, 'canManageBilling'>;
	}).pipe(Effect.withSpan('Billing.summary'));

	// Suspended: the layer is also built for tenant-less programs, where
	// reading the org is a defect.
	const checkoutUrl = Effect.suspend(() =>
		autumn.checkoutUrl({
			customerId: org.id,
			planId: PRO_PLAN_ID,
			successUrl: billingPage
		})
	).pipe(Effect.withSpan('Billing.checkoutUrl'));

	const portalUrl = Effect.suspend(() =>
		autumn.portalUrl({ customerId: org.id, returnUrl: billingPage })
	).pipe(Effect.withSpan('Billing.portalUrl'));

	const syncUsage = Effect.gen(function* () {
		// Retain obligations while billing is unconfigured; a no-op provider
		// must never acknowledge and discard real usage.
		if (!autumn.enabled) return;
		yield* sql
			.withTransaction(
				Effect.gen(function* () {
					// Serialize the bounded provider calls with usage mutations, so
					// older storage snapshots cannot overwrite newer ones out of order.
					yield* sql`SELECT org_id FROM org_usage WHERE org_id = ${org.id} FOR UPDATE`;
					const rows = yield* sql<{
						stored_bytes: number;
						ai_ops_month: number;
						ai_ops_reset_at: number;
					}>`SELECT stored_bytes,
					CASE WHEN ai_ops_month_reset_at IS NULL OR ai_ops_month_reset_at <= now()
						THEN 0 ELSE ai_ops_month END AS ai_ops_month,
					EXTRACT(epoch FROM ((date_trunc('month', now() AT TIME ZONE 'UTC') + interval '1 month') AT TIME ZONE 'UTC')) * 1000 AS ai_ops_reset_at
				FROM org_usage WHERE org_id = ${org.id}`;
					const usage = rows.at(0);
					if (!usage) return;
					yield* autumn.updateBalance({
						customerId: org.id,
						featureId: 'storage_bytes',
						usage: usage.stored_bytes
					});
					yield* autumn.updateBalance({
						customerId: org.id,
						featureId: 'ai_ops',
						usage: usage.ai_ops_month,
						interval: 'month',
						nextResetAt: usage.ai_ops_reset_at
					});
					yield* sql`UPDATE org_usage
				SET usage_sync_next_run_at = clock_timestamp() + ${STUCK_JOB_MS} * interval '1 millisecond'
				WHERE org_id = ${org.id}`;
				})
			)
			.pipe(
				Effect.mapError(
					(cause) =>
						new StorageError({ operation: 'sync billing usage', cause })
				)
			);
	}).pipe(Effect.withSpan('Billing.syncUsage'));

	return Billing.of({ summary, checkoutUrl, portalUrl, syncUsage });
});

export const BillingLive = Layer.effect(Billing, makeBilling);
