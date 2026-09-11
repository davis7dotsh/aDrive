import { describe, expect, it, onTestFinished, vi } from 'vitest';
import { Effect } from 'effect';
import type { DashboardFile } from '@adrive/shared';
import type { PgSql } from '$lib/server/pg';

vi.mock('$app/server', async () => {
	const { mockGetRequestEvent } = await import('../test/route-context.js');
	return mockGetRequestEvent();
});

import {
	call,
	createRouteContext,
	type RouteTestContext
} from '../test/route-context';
import {
	currentIdentity,
	login,
	mutateFile,
	uploadFile
} from '../test/helpers';

const queryPg = async <A>(
	env: Env,
	query: (sql: PgSql['Service']) => Effect.Effect<A, unknown>
) => {
	const { runWorkerProgram } = await import('$lib/server/edge');
	const { PgSql } = await import('$lib/server/pg');
	return runWorkerProgram(env, Effect.flatMap(PgSql, query));
};

const mockEmbeddings = (env: Env) => {
	const run = vi.fn(async (_model: string, input: { text: string[] }) => ({
		shape: [input.text.length, 384],
		pooling: 'cls',
		data: input.text.map((_, index) =>
			Array.from({ length: 384 }, (_, dimension) =>
				dimension === index % 384 ? 1 : 0
			)
		)
	}));
	Object.defineProperty(env, 'AI', {
		value: { run },
		configurable: true,
		writable: true
	});
	onTestFinished(() => {
		Reflect.deleteProperty(env, 'AI');
	});
	return run;
};

const fileDetail = async (ctx: RouteTestContext, id: string) => {
	const { GET } = await import('../../../routes/api/files/[id]/+server.js');
	const response = await call(
		GET,
		ctx.event({ path: `/api/files/${id}`, params: { id } })
	);
	if (!response.ok) throw new Error(`Detail failed: ${response.status}`);
	return ((await response.json()) as { file: DashboardFile }).file;
};

const autumnCalls = async (orgId: string) => {
	const { autumnFakeCalls } = await import('$lib/server/services/autumn');
	return autumnFakeCalls.filter((entry) => entry.input.customerId === orgId);
};

describe('billing gates and usage sync (local platform)', () => {
	let shared: RouteTestContext | undefined;
	const setup = async () => {
		shared ??= await createRouteContext();
		shared.jobs.splice(0);
		const { autumnFakeCalls, autumnFakeAllowed, autumnFakePlans } =
			await import('$lib/server/services/autumn');
		autumnFakeCalls.splice(0);
		autumnFakeAllowed.clear();
		autumnFakePlans.clear();
		return shared;
	};

	it('creates the Autumn customer on first sign-in', async () => {
		const ctx = await setup();
		const { loginAs } = await import('../test/helpers');
		await loginAs(ctx, { userId: `user_billing_${crypto.randomUUID()}` });
		const identity = await currentIdentity(ctx);
		expect(await autumnCalls(identity.orgId)).toEqual([
			{
				method: 'ensureCustomer',
				input: {
					customerId: identity.orgId,
					name: identity.orgName,
					email: identity.email
				}
			}
		]);
	});

	it('syncs stored bytes and embedded chunks after upload and purge', async () => {
		const ctx = await setup();
		await login(ctx);
		mockEmbeddings(ctx.env);
		const identity = await currentIdentity(ctx);
		const file = await uploadFile(ctx, {
			name: 'metered.txt',
			content: 'metered through autumn'
		});
		expect(ctx.jobs.map((job) => job.body.kind)).toEqual([
			'index',
			'scan',
			'usage-sync'
		]);
		await ctx.drainJobs();
		const stored = await queryPg(
			ctx.env,
			(sql) => sql<{ stored_bytes: number; ai_ops_month: number }>`
				SELECT stored_bytes, ai_ops_month FROM org_usage
				WHERE org_id = ${identity.orgId}`
		);
		expect(stored[0]?.ai_ops_month).toBe(1);
		expect((await fileDetail(ctx, file.id)).indexState).toBe('ready');
		// Both deliveries send the same absolute counters, so retrying a
		// successful provider write cannot count the embedding twice.
		const calls = await autumnCalls(identity.orgId);
		expect(calls.map((entry) => entry.method)).toEqual([
			'check',
			'updateBalance',
			'updateBalance',
			'updateBalance',
			'updateBalance'
		]);
		expect(calls[1]?.input).toEqual({
			customerId: identity.orgId,
			featureId: 'storage_bytes',
			usage: stored[0]?.stored_bytes
		});
		expect(calls[2]?.input).toEqual({
			customerId: identity.orgId,
			featureId: 'ai_ops',
			usage: 1,
			interval: 'month',
			nextResetAt: expect.any(Number)
		});

		const { autumnFakeCalls } = await import('$lib/server/services/autumn');
		autumnFakeCalls.splice(0);
		await mutateFile(ctx, file.id, { action: 'trash' });
		await mutateFile(ctx, file.id, { action: 'purge' });
		await ctx.drainJobs();
		const released = await queryPg(
			ctx.env,
			(sql) => sql<{ stored_bytes: number }>`
				SELECT stored_bytes FROM org_usage WHERE org_id = ${identity.orgId}`
		);
		expect(
			(await autumnCalls(identity.orgId))
				.filter((entry) => entry.input.featureId === 'storage_bytes')
				.at(-1)
		).toEqual({
			method: 'updateBalance',
			input: {
				customerId: identity.orgId,
				featureId: 'storage_bytes',
				usage: released[0]?.stored_bytes
			}
		});
	});

	it('shows the plan and usage and hands out checkout and portal links', async () => {
		const ctx = await setup();
		await login(ctx);
		const identity = await currentIdentity(ctx);
		const { GET } = await import('../../../routes/api/billing/+server.js');
		const summary = await call(GET, ctx.event({ path: '/api/billing' }));
		expect(summary.status).toBe(200);
		const usage = await queryPg(
			ctx.env,
			(sql) => sql<{ stored_bytes: number }>`
				SELECT stored_bytes FROM org_usage WHERE org_id = ${identity.orgId}`
		);
		const { planLimits } = await import('$lib/server/plans');
		expect(await summary.json()).toMatchObject({
			plan: 'free',
			planName: 'Free',
			billingEnabled: true,
			storage: {
				used: usage[0]?.stored_bytes,
				limit: planLimits('free').storedBytes
			},
			aiOps: { limit: planLimits('free').aiOpsPerMonth }
		});

		const { POST: checkout } =
			await import('../../../routes/api/billing/checkout/+server.js');
		const started = await call(
			checkout,
			ctx.event({ method: 'POST', path: '/api/billing/checkout' })
		);
		expect(started.status).toBe(200);
		expect(await started.json()).toEqual({
			url: `https://checkout.autumn.invalid/${identity.orgId}/pro`
		});
		const { POST: portal } =
			await import('../../../routes/api/billing/portal/+server.js');
		const opened = await call(
			portal,
			ctx.event({ method: 'POST', path: '/api/billing/portal' })
		);
		expect(await opened.json()).toEqual({
			url: `https://portal.autumn.invalid/${identity.orgId}`
		});
		expect(
			(await autumnCalls(identity.orgId)).map((entry) => [
				entry.method,
				entry.input
			])
		).toEqual([
			[
				'checkoutUrl',
				{
					customerId: identity.orgId,
					planId: 'pro',
					successUrl: 'http://localhost:5173/settings/billing'
				}
			],
			[
				'portalUrl',
				{
					customerId: identity.orgId,
					returnUrl: 'http://localhost:5173/settings/billing'
				}
			]
		]);

		// A read-only key can see the summary but not change the plan.
		const { POST: createKey } =
			await import('../../../routes/api/auth/keys/+server.js');
		const created = await call(
			createKey,
			ctx.event({
				method: 'POST',
				path: '/api/auth/keys',
				body: JSON.stringify({ name: 'billing-ro', scope: 'read-only' }),
				headers: { 'content-type': 'application/json' }
			})
		);
		const { token } = (await created.json()) as { token: string };
		const asKey = (method: string, path: string) =>
			ctx.event({
				method,
				path,
				headers: { authorization: `Bearer ${token}` }
			});
		expect((await call(GET, asKey('GET', '/api/billing'))).status).toBe(200);
		await expect(
			call(checkout, asKey('POST', '/api/billing/checkout'))
		).rejects.toMatchObject({ status: 403 });
	});

	it('reconciles current subscriptions on signed webhook delivery and redelivery', async () => {
		const ctx = await setup();
		await login(ctx);
		const identity = await currentIdentity(ctx);
		const { POST } =
			await import('../../../routes/api/webhooks/autumn/+server.js');
		const { signSvix } = await import('$lib/server/svix');
		const planOf = async () =>
			(
				await queryPg(
					ctx.env,
					(sql) => sql<{ plan: string }>`
						SELECT plan FROM orgs WHERE id = ${identity.orgId}`
				)
			)[0]?.plan;
		const deliver = async (
			body: unknown,
			options: { readonly secret?: string; readonly headers?: boolean } = {}
		) => {
			const payload = JSON.stringify(body);
			const id = `msg_${crypto.randomUUID()}`;
			const timestamp = String(Math.floor(Date.now() / 1000));
			const signature = await signSvix(
				options.secret ?? ctx.env.AUTUMN_WEBHOOK_SECRET ?? '',
				id,
				timestamp,
				payload
			);
			return call(
				POST,
				ctx.event({
					method: 'POST',
					path: '/api/webhooks/autumn',
					body: payload,
					headers: {
						'content-type': 'application/json',
						...(options.headers === false
							? {}
							: {
									'svix-id': id,
									'svix-timestamp': timestamp,
									'svix-signature': signature ?? ''
								})
					}
				})
			);
		};
		const upgrade = {
			type: 'billing.updated',
			data: {
				object: 'billing.updated',
				customer_id: identity.orgId,
				plan_changes: [
					{
						action: 'activated',
						subscription: { plan_id: 'pro', status: 'active' }
					},
					{
						action: 'expired',
						subscription: { plan_id: 'free', status: 'expired' }
					}
				],
				tags: []
			}
		};
		expect(await planOf()).toBe('free');
		await expect(deliver(upgrade, { headers: false })).rejects.toMatchObject({
			status: 401
		});
		await expect(
			deliver(upgrade, { secret: 'whsec_bm90LXRoZS1zZWNyZXQ=' })
		).rejects.toMatchObject({ status: 401 });
		expect(await planOf()).toBe('free');

		const { autumnFakePlans } = await import('$lib/server/services/autumn');
		autumnFakePlans.set(identity.orgId, 'pro');
		expect((await deliver(upgrade)).status).toBe(200);
		expect(await planOf()).toBe('pro');
		// The storage limit follows the plan.
		const { GET } = await import('../../../routes/api/billing/+server.js');
		const { planLimits } = await import('$lib/server/plans');
		expect(
			await (await call(GET, ctx.event({ path: '/api/billing' }))).json()
		).toMatchObject({
			plan: 'pro',
			storage: { limit: planLimits('pro').storedBytes }
		});

		const downgrade = {
			type: 'billing.updated',
			data: {
				object: 'billing.updated',
				customer_id: identity.orgId,
				plan_changes: [
					{
						action: 'expired',
						subscription: { plan_id: 'pro', status: 'expired' }
					}
				],
				tags: []
			}
		};
		// The expired delta does not downgrade a currently active Pro customer.
		expect((await deliver(downgrade)).status).toBe(200);
		expect(await planOf()).toBe('pro');
		autumnFakePlans.set(identity.orgId, 'free');
		expect((await deliver(downgrade)).status).toBe(200);
		expect(await planOf()).toBe('free');
		// A delayed old upgrade cannot restore a subscription that has ended.
		expect((await deliver(upgrade)).status).toBe(200);
		expect(await planOf()).toBe('free');

		// Other events and unknown customers are acknowledged.
		expect(
			(
				await deliver({
					type: 'balances.limit_reached',
					data: { customer_id: identity.orgId, feature_id: 'ai_ops' }
				})
			).status
		).toBe(200);
		expect(
			(
				await deliver({
					...upgrade,
					data: { ...upgrade.data, customer_id: 'org_nobody' }
				})
			).status
		).toBe(200);
		expect(await planOf()).toBe('free');
	});

	it('finishes keyword-only when the AI quota is exhausted', async () => {
		const ctx = await setup();
		await login(ctx);
		const embed = mockEmbeddings(ctx.env);
		const { autumnFakeAllowed } = await import('$lib/server/services/autumn');
		autumnFakeAllowed.set('ai_ops', false);
		const file = await uploadFile(ctx, {
			name: 'over-quota.txt',
			content: 'no embeddings for this one'
		});
		const decisions = await ctx.drainJobs();
		expect(decisions.every((decision) => 'ack' in decision)).toBe(true);
		expect(embed).not.toHaveBeenCalled();
		const indexed = await fileDetail(ctx, file.id);
		expect(indexed.indexState).toBe('disabled');
		expect(indexed.indexError).toBe('AI quota exhausted');
		expect(indexed.indexAttempts).toBe(0);

		// Keyword search still finds it.
		const { GET } = await import('../../../routes/api/search/+server.js');
		const response = await call(
			GET,
			ctx.event({ path: '/api/search?q=embeddings' })
		);
		expect(response.status).toBe(200);
		const body = (await response.json()) as { files: Array<{ id: string }> };
		expect(body.files.map((entry) => entry.id)).toContain(file.id);

		// Quota back (a new month or an upgrade): the sweep re-offers it.
		// (The search above embedded its query through the same mock.)
		const embedCallsBeforeSweep = embed.mock.calls.length;
		autumnFakeAllowed.clear();
		await queryPg(
			ctx.env,
			(sql) => sql`
				UPDATE files SET index_next_run_at = now() - interval '20 minutes',
					updated_at = now() - interval '20 minutes'
				WHERE id = ${file.id}`
		);
		const { runWorkerProgram } = await import('$lib/server/edge');
		const { Indexing } = await import('$lib/server/services/indexing');
		const identity = await currentIdentity(ctx);
		expect(
			await runWorkerProgram(
				ctx.env,
				Effect.flatMap(Indexing, (indexing) => indexing.runDue(10)),
				identity
			)
		).toBe(1);
		await ctx.drainJobs();
		expect(embed.mock.calls.length).toBe(embedCallsBeforeSweep + 1);
		expect((await fileDetail(ctx, file.id)).indexState).toBe('ready');
	});

	it('preserves keyword search when the local quota is full even if Autumn allows', async () => {
		const ctx = await setup();
		const { loginAs } = await import('../test/helpers');
		await loginAs(ctx, { userId: `user_local_ai_${crypto.randomUUID()}` });
		const identity = await currentIdentity(ctx);
		const embed = mockEmbeddings(ctx.env);
		await queryPg(
			ctx.env,
			(sql) => sql`UPDATE org_usage
			SET ai_ops_month = 500,
				ai_ops_month_reset_at = (date_trunc('month', now() AT TIME ZONE 'UTC') + interval '1 month') AT TIME ZONE 'UTC'
			WHERE org_id = ${identity.orgId}`
		);
		const file = await uploadFile(ctx, {
			name: 'local-quota.txt',
			content: 'keyword search remains available'
		});
		await ctx.drainJobs();
		expect(embed).not.toHaveBeenCalled();
		expect(await fileDetail(ctx, file.id)).toMatchObject({
			indexState: 'disabled',
			indexError: 'AI quota exhausted'
		});
		expect(
			(await autumnCalls(identity.orgId)).some(
				(entry) =>
					entry.method === 'check' && entry.input.featureId === 'ai_ops'
			)
		).toBe(true);
	});
});
