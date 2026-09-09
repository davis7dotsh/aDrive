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
		const { autumnFakeCalls, autumnFakeAllowed } =
			await import('$lib/server/services/autumn');
		autumnFakeCalls.splice(0);
		autumnFakeAllowed.clear();
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
		// The index job runs first in the batch (its check, then the
		// embeddings it meters), so the upload's sync already carries the
		// chunk; the sync the index job sent has only the balance to report.
		const calls = await autumnCalls(identity.orgId);
		expect(calls.map((entry) => entry.method)).toEqual([
			'check',
			'updateBalance',
			'track',
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
			value: 1
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
		expect((await autumnCalls(identity.orgId)).at(-1)).toEqual({
			method: 'updateBalance',
			input: {
				customerId: identity.orgId,
				featureId: 'storage_bytes',
				usage: released[0]?.stored_bytes
			}
		});
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
});
