import { Context, Effect, Layer } from 'effect';
import type { StorageError } from '../errors';
import { PgSql } from '../pg';
import { readOrgUsage, settleAiOps } from '../usage';
import { AutumnClient } from './autumn';
import { CurrentOrg } from './current-org';

export interface BillingShape {
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

	return Billing.of({ syncUsage });
});

export const BillingLive = Layer.effect(Billing, makeBilling);
