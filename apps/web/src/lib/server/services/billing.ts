import type { BillingSummary } from '@adrive/shared';
import { Context, Effect, Layer } from 'effect';
import { AppConfig } from '../config';
import { StorageError } from '../errors';
import { PgSql } from '../pg';
import { PRO_PLAN_ID, planLimits } from '../plans';
import { readOrgUsage, settleAiOps } from '../usage';
import { AutumnClient } from './autumn';
import { CurrentOrg } from './current-org';

const PLAN_NAMES: Record<string, string> = { free: 'Free', pro: 'Pro' };

export interface BillingShape {
	readonly summary: Effect.Effect<BillingSummary, StorageError>;
	// Hosted checkout for the pro plan; null when the plan attached with
	// no payment step, or billing is not configured.
	readonly checkoutUrl: Effect.Effect<string | null, StorageError>;
	// The customer portal (cards, invoices, cancellation).
	readonly portalUrl: Effect.Effect<string | null, StorageError>;
	// The usage-sync job: pushes the current stored bytes to Autumn as the
	// storage balance and tracks the AI operations recorded since the last
	// sync. Reads the row at run time, so several sends coalesce into the
	// same answer and a failed run is retried with nothing lost.
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
		} satisfies BillingSummary;
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
		const usage = yield* readOrgUsage(sql, org.id);
		// The org was deleted after the job was sent: nothing to report.
		if (usage === null) return;
		yield* autumn.updateBalance({
			customerId: org.id,
			featureId: 'storage_bytes',
			usage: usage.storedBytes
		});
		if (usage.aiOpsPending > 0) {
			yield* autumn.track({
				customerId: org.id,
				featureId: 'ai_ops',
				value: usage.aiOpsPending
			});
			yield* settleAiOps(sql, org.id, usage.aiOpsPending);
		}
	}).pipe(Effect.withSpan('Billing.syncUsage'));

	return Billing.of({ summary, checkoutUrl, portalUrl, syncUsage });
});

export const BillingLive = Layer.effect(Billing, makeBilling);
