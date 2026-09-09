import { Effect, Layer } from 'effect';
import { describe, expect, it } from 'vitest';
import { AppConfig, type AppConfigShape } from '../config';
import { PgSql } from '../pg';
import { testTenant } from '../test/org';
import { testPgLayer } from '../test/pg';
import { ensureTenant } from '../tenants';
import { readOrgUsage, recordAiOps, settleAiOps } from '../usage';
import {
	AutumnClient,
	autumnFake,
	autumnFakeCalls,
	type AutumnFakeCall
} from './autumn';
import { Billing, BillingLive } from './billing';
import { CurrentOrg } from './current-org';

const config: AppConfigShape = {
	dashboardOrigin: 'https://drive.example.test',
	contentDomain: 'content.example.test',
	contentScheme: 'https:',
	contentOriginFor: (slug) => `https://${slug}.content.example.test`,
	maxUploadBytes: 1,
	maintenanceSecret: 'test-maintenance-secret',
	workos: { apiKey: null, clientId: '', cookiePassword: '', webhookSecret: '' },
	urlScanner: null,
	cloudflareZone: null,
	adminUserIds: new Set(),
	autumn: { secretKey: 'fake:test', webhookSecret: '' },
	semanticSearch: 'off',
	embeddingModel: '@cf/baai/bge-small-en-v1.5',
	embeddingPooling: 'cls',
	embeddingDimensions: 384
};

const billingLayer = (orgId: string) =>
	BillingLive.pipe(
		Layer.provideMerge(
			Layer.mergeAll(
				testPgLayer(),
				Layer.succeed(AppConfig, config),
				Layer.succeed(AutumnClient, autumnFake),
				Layer.succeed(CurrentOrg, { id: orgId, slug: orgId })
			)
		)
	);

const run = <A, E>(
	orgId: string,
	effect: Effect.Effect<A, E, PgSql | Billing>
) => Effect.runPromise(effect.pipe(Effect.provide(billingLayer(orgId))));

const callsFor = (orgId: string) =>
	autumnFakeCalls.filter(
		(call: AutumnFakeCall) => call.input.customerId === orgId
	);

describe('usage sync into Autumn', () => {
	it('reports stored bytes and the AI operations owed since the last sync', async () => {
		const orgId = `org_billing_${crypto.randomUUID().slice(0, 8)}`;
		const result = await run(
			orgId,
			Effect.gen(function* () {
				const sql = yield* PgSql;
				yield* ensureTenant(sql, testTenant(orgId, `user_${orgId}`));
				yield* sql`
					UPDATE org_usage SET stored_bytes = 4096 WHERE org_id = ${orgId}`;
				yield* recordAiOps(sql, orgId, 3);
				yield* recordAiOps(sql, orgId, 4);
				const before = yield* readOrgUsage(sql, orgId);
				const billing = yield* Billing;
				yield* billing.syncUsage;
				const afterFirst = yield* readOrgUsage(sql, orgId);
				// Nothing new: the storage balance is re-sent, no usage is.
				yield* billing.syncUsage;
				const afterSecond = yield* readOrgUsage(sql, orgId);
				return { before, afterFirst, afterSecond };
			})
		);
		expect(result.before).toEqual({
			storedBytes: 4096,
			fileCount: 0,
			aiOpsMonth: 7,
			aiOpsPending: 7
		});
		expect(result.afterFirst?.aiOpsPending).toBe(0);
		expect(result.afterFirst?.aiOpsMonth).toBe(7);
		expect(result.afterSecond?.aiOpsPending).toBe(0);
		expect(callsFor(orgId)).toEqual([
			{
				method: 'updateBalance',
				input: { customerId: orgId, featureId: 'storage_bytes', usage: 4096 }
			},
			{
				method: 'track',
				input: { customerId: orgId, featureId: 'ai_ops', value: 7 }
			},
			{
				method: 'updateBalance',
				input: { customerId: orgId, featureId: 'storage_bytes', usage: 4096 }
			}
		]);
	});

	it('restarts the monthly counter once its month is over', async () => {
		const orgId = `org_billing_${crypto.randomUUID().slice(0, 8)}`;
		const result = await run(
			orgId,
			Effect.gen(function* () {
				const sql = yield* PgSql;
				yield* ensureTenant(sql, testTenant(orgId, `user_${orgId}`));
				yield* recordAiOps(sql, orgId, 5);
				yield* sql`
					UPDATE org_usage
					SET ai_ops_month_reset_at = now() - interval '1 day'
					WHERE org_id = ${orgId}`;
				const lapsed = yield* readOrgUsage(sql, orgId);
				yield* recordAiOps(sql, orgId, 2);
				const restarted = yield* readOrgUsage(sql, orgId);
				yield* settleAiOps(sql, orgId, 100);
				const settled = yield* readOrgUsage(sql, orgId);
				return { lapsed, restarted, settled };
			})
		);
		expect(result.lapsed?.aiOpsMonth).toBe(0);
		expect(result.lapsed?.aiOpsPending).toBe(5);
		expect(result.restarted?.aiOpsMonth).toBe(2);
		expect(result.restarted?.aiOpsPending).toBe(7);
		expect(result.settled?.aiOpsPending).toBe(0);
	});

	it('does nothing for an org without a usage row', async () => {
		const orgId = `org_billing_missing_${crypto.randomUUID().slice(0, 8)}`;
		await run(
			orgId,
			Effect.flatMap(Billing, (billing) => billing.syncUsage)
		);
		expect(callsFor(orgId)).toEqual([]);
	});
});
