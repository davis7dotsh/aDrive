import { Effect, Exit, Layer } from 'effect';
import { describe, expect, it } from 'vitest';
import { AppConfig, type AppConfigShape } from '../config';
import { StorageError } from '../errors';
import { PgSql } from '../pg';
import { testTenant } from '../test/org';
import { testPgLayer } from '../test/pg';
import { ensureTenant } from '../tenants';
import { readOrgUsage, recordAiOps, recoverUsageSync } from '../usage';
import {
	AutumnClient,
	type AutumnClientShape,
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

const billingLayer = (orgId: string, autumn: AutumnClientShape = autumnFake) =>
	BillingLive.pipe(
		Layer.provideMerge(
			Layer.mergeAll(
				testPgLayer(),
				Layer.succeed(AppConfig, config),
				Layer.succeed(AutumnClient, autumn),
				Layer.succeed(CurrentOrg, { id: orgId, slug: orgId })
			)
		)
	);

const run = <A, E>(
	orgId: string,
	effect: Effect.Effect<A, E, PgSql | Billing>,
	autumn: AutumnClientShape = autumnFake
) =>
	Effect.runPromise(effect.pipe(Effect.provide(billingLayer(orgId, autumn))));

const callsFor = (orgId: string) =>
	autumnFakeCalls.filter(
		(call: AutumnFakeCall) => call.input.customerId === orgId
	);

const nextUtcMonth = () => {
	const now = new Date();
	return Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1);
};

const aiCalls = (orgId: string) =>
	callsFor(orgId).filter((call) => call.input.featureId === 'ai_ops');

describe('usage sync into Autumn', () => {
	it('replays absolute stored bytes and successful AI usage without adding it twice', async () => {
		const orgId = `org_billing_${crypto.randomUUID().slice(0, 8)}`;
		const result = await run(
			orgId,
			Effect.gen(function* () {
				const sql = yield* PgSql;
				yield* ensureTenant(sql, testTenant(orgId, `user_${orgId}`));
				yield* sql`UPDATE org_usage SET stored_bytes = 4096 WHERE org_id = ${orgId}`;
				yield* recordAiOps(sql, orgId, 3);
				yield* recordAiOps(sql, orgId, 4);
				const before = yield* readOrgUsage(sql, orgId);
				const billing = yield* Billing;
				yield* billing.syncUsage;
				yield* billing.syncUsage;
				return { before, after: yield* readOrgUsage(sql, orgId) };
			})
		);
		expect(result.before).toEqual({
			storedBytes: 4096,
			fileCount: 0,
			aiOpsMonth: 7
		});
		expect(result.after).toEqual(result.before);
		const snapshot = [
			{
				method: 'updateBalance',
				input: { customerId: orgId, featureId: 'storage_bytes', usage: 4096 }
			},
			{
				method: 'updateBalance',
				input: {
					customerId: orgId,
					featureId: 'ai_ops',
					usage: 7,
					interval: 'month',
					nextResetAt: nextUtcMonth()
				}
			}
		];
		expect(callsFor(orgId)).toEqual([...snapshot, ...snapshot]);
	});

	it('resets to zero without new work and uses UTC regardless of the database timezone', async () => {
		const orgId = `org_billing_${crypto.randomUUID().slice(0, 8)}`;
		const result = await run(
			orgId,
			Effect.gen(function* () {
				const sql = yield* PgSql;
				yield* ensureTenant(sql, testTenant(orgId, `user_${orgId}`));
				yield* recordAiOps(sql, orgId, 5);
				yield* sql`UPDATE org_usage SET ai_ops_month_reset_at = now() - interval '1 day' WHERE org_id = ${orgId}`;
				return yield* sql.withTransaction(
					Effect.gen(function* () {
						yield* sql`SET LOCAL TIME ZONE 'Pacific/Honolulu'`;
						const lapsed = yield* readOrgUsage(sql, orgId);
						const billing = yield* Billing;
						yield* billing.syncUsage;
						yield* recordAiOps(sql, orgId, 2);
						const restarted = yield* readOrgUsage(sql, orgId);
						const rows = yield* sql<{
							ai_ops_month_reset_at: string;
						}>`SELECT ai_ops_month_reset_at FROM org_usage WHERE org_id = ${orgId}`;
						return {
							lapsed,
							restarted,
							resetAt: rows[0]?.ai_ops_month_reset_at
						};
					})
				);
			})
		);
		expect(result.lapsed?.aiOpsMonth).toBe(0);
		expect(result.restarted?.aiOpsMonth).toBe(2);
		expect(result.resetAt).toBe(new Date(nextUtcMonth()).toISOString());
		expect(aiCalls(orgId)).toEqual([
			{
				method: 'updateBalance',
				input: {
					customerId: orgId,
					featureId: 'ai_ops',
					usage: 0,
					interval: 'month',
					nextResetAt: nextUtcMonth()
				}
			}
		]);
	});

	it('does nothing for an org without a usage row', async () => {
		const orgId = `org_billing_missing_${crypto.randomUUID().slice(0, 8)}`;
		await run(
			orgId,
			Effect.flatMap(Billing, (billing) => billing.syncUsage)
		);
		expect(callsFor(orgId)).toEqual([]);
	});

	it('serializes overlapping provider writes', async () => {
		const orgId = `org_billing_${crypto.randomUUID().slice(0, 8)}`;
		let active = 0;
		let maximum = 0;
		const autumn: AutumnClientShape = {
			...autumnFake,
			updateBalance: (input) =>
				Effect.gen(function* () {
					active += 1;
					maximum = Math.max(maximum, active);
					yield* Effect.yieldNow;
					yield* autumnFake.updateBalance(input);
					active -= 1;
				})
		};
		await run(
			orgId,
			Effect.gen(function* () {
				const sql = yield* PgSql;
				yield* ensureTenant(sql, testTenant(orgId, `user_${orgId}`));
				yield* recordAiOps(sql, orgId, 7);
				const billing = yield* Billing;
				yield* Effect.all([billing.syncUsage, billing.syncUsage], {
					concurrency: 'unbounded'
				});
			}),
			autumn
		);
		expect(maximum).toBe(1);
		expect(aiCalls(orgId).map((call) => call.input.usage)).toEqual([7, 7]);
	});

	it('repairs a lost acknowledgement using the latest absolute usage', async () => {
		const orgId = `org_billing_${crypto.randomUUID().slice(0, 8)}`;
		const attempts: number[] = [];
		let providerUsage = 0;
		let loseAcknowledgement = true;
		const autumn: AutumnClientShape = {
			...autumnFake,
			updateBalance: (input) =>
				Effect.suspend(() => {
					if (input.featureId !== 'ai_ops') return Effect.void;
					attempts.push(input.usage);
					providerUsage = input.usage;
					if (loseAcknowledgement) {
						loseAcknowledgement = false;
						return Effect.fail(
							new StorageError({
								operation: 'update balance',
								cause: 'acknowledgement lost'
							})
						);
					}
					return Effect.void;
				})
		};
		const result = await run(
			orgId,
			Effect.gen(function* () {
				const sql = yield* PgSql;
				yield* ensureTenant(sql, testTenant(orgId, `user_${orgId}`));
				yield* recordAiOps(sql, orgId, 7);
				const billing = yield* Billing;
				const failed = yield* Effect.exit(billing.syncUsage);
				const rows = yield* sql<{
					due: boolean;
				}>`SELECT usage_sync_next_run_at <= now() AS due FROM org_usage WHERE org_id = ${orgId}`;
				yield* recordAiOps(sql, orgId, 4);
				yield* billing.syncUsage;
				yield* billing.syncUsage;
				return {
					failed: Exit.isFailure(failed),
					due: rows[0]?.due,
					final: yield* readOrgUsage(sql, orgId)
				};
			}),
			autumn
		);
		expect(result.failed).toBe(true);
		expect(result.due).toBe(true);
		expect(result.final?.aiOpsMonth).toBe(11);
		expect(providerUsage).toBe(11);
		expect(attempts).toEqual([7, 11, 11]);
	});

	it('recovers lost usage-sync sends even when no AI work was recorded', async () => {
		const orgId = `org_billing_${crypto.randomUUID().slice(0, 8)}`;
		const jobs: Array<{ kind: string; orgId: string }> = [];
		const queue = {
			send: () => Effect.void,
			trySend: (job: { kind: string; orgId: string }) =>
				Effect.sync(() => {
					jobs.push(job);
				})
		};
		await run(
			orgId,
			Effect.gen(function* () {
				const sql = yield* PgSql;
				yield* ensureTenant(sql, testTenant(orgId, `user_${orgId}`));
				expect(yield* recoverUsageSync(sql, queue, orgId)).toBe(1);
				expect(yield* recoverUsageSync(sql, queue, orgId)).toBe(0);
				// The queue accepted nothing: a later sweep still has an obligation.
				yield* sql`UPDATE org_usage SET usage_sync_next_run_at = now() - interval '1 minute' WHERE org_id = ${orgId}`;
				expect(yield* recoverUsageSync(sql, queue, orgId)).toBe(1);
			})
		);
		expect(jobs).toEqual([
			{ kind: 'usage-sync', orgId },
			{ kind: 'usage-sync', orgId }
		]);
	});
});
