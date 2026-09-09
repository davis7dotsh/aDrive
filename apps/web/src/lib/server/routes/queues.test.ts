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
import { currentIdentity, login, uploadFile } from '../test/helpers';

const queryPg = async <A>(
	env: Env,
	query: (sql: PgSql['Service']) => Effect.Effect<A, unknown>
) => {
	const { runWorkerProgram } = await import('$lib/server/edge');
	const { PgSql } = await import('$lib/server/pg');
	return runWorkerProgram(env, Effect.flatMap(PgSql, query));
};

// A Workers AI stand-in so indexing can reach `ready` (without it the
// row settles at keyword-only `disabled`). Each call can be made to fail
// once to exercise the retry path.
const mockEmbeddings = (env: Env, failures = 0) => {
	let remainingFailures = failures;
	const run = vi.fn(async (_model: string, input: { text: string[] }) => {
		if (remainingFailures > 0) {
			remainingFailures -= 1;
			throw new Error('embedding service unavailable');
		}
		return {
			shape: [input.text.length, 384],
			pooling: 'cls',
			data: input.text.map((_, index) =>
				Array.from({ length: 384 }, (_, dimension) =>
					dimension === index % 384 ? 1 : 0
				)
			)
		};
	});
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

describe('queue-driven indexing (local platform)', () => {
	let shared: RouteTestContext | undefined;
	const setup = async () => {
		shared ??= await createRouteContext();
		shared.jobs.splice(0);
		return shared;
	};

	it('sends an index job on upload and the consumer makes the file ready', async () => {
		const ctx = await setup();
		await login(ctx);
		const embed = mockEmbeddings(ctx.env);
		const file = await uploadFile(ctx, {
			name: 'queued.txt',
			content: 'indexed through the queue'
		});
		const identity = await currentIdentity(ctx);
		expect(ctx.jobs).toEqual([
			{
				body: {
					kind: 'index',
					orgId: identity.orgId,
					fileId: file.id,
					version: 1
				},
				delaySeconds: 0
			}
		]);
		expect((await fileDetail(ctx, file.id)).indexState).toBe('pending');

		const decisions = await ctx.drainJobs();
		expect(decisions).toEqual([{ id: 'test-1', ack: true }]);
		expect(embed).toHaveBeenCalledOnce();
		const indexed = await fileDetail(ctx, file.id);
		expect(indexed.indexState).toBe('ready');
		expect(indexed.indexedVersion).toBe(1);
	});

	it('retries a transient embedding failure with backoff', async () => {
		const ctx = await setup();
		await login(ctx);
		mockEmbeddings(ctx.env, 1);
		const file = await uploadFile(ctx, {
			name: 'flaky.txt',
			content: 'first attempt fails'
		});

		const decisions = await ctx.drainJobs();
		expect(decisions).toEqual([
			{ id: 'test-1', retry: true, delaySeconds: 60 },
			{ id: 'test-2', ack: true }
		]);
		const indexed = await fileDetail(ctx, file.id);
		expect(indexed.indexState).toBe('ready');
		expect(indexed.indexAttempts).toBe(0);
	});

	it('skips a stale version and indexes the current one', async () => {
		const ctx = await setup();
		await login(ctx);
		mockEmbeddings(ctx.env);
		const file = await uploadFile(ctx, {
			name: 'versioned.txt',
			content: 'version one'
		});
		const { PUT } =
			await import('../../../routes/api/files/[id]/versions/+server.js');
		const response = await call(
			PUT,
			ctx.event({
				method: 'PUT',
				path: `/api/files/${file.id}/versions`,
				body: 'version two',
				headers: { 'content-type': 'text/plain' },
				params: { id: file.id }
			})
		);
		expect(response.status).toBe(201);
		expect(ctx.jobs.map((job) => job.body)).toMatchObject([
			{ kind: 'index', fileId: file.id, version: 1 },
			{ kind: 'index', fileId: file.id, version: 2 }
		]);

		await ctx.drainJobs();
		const indexed = await fileDetail(ctx, file.id);
		expect(indexed.indexState).toBe('ready');
		expect(indexed.indexedVersion).toBe(2);
	});

	it('re-sends jobs for rows stuck in pending', async () => {
		const ctx = await setup();
		await login(ctx);
		const file = await uploadFile(ctx, { name: 'stuck.txt' });
		const identity = await currentIdentity(ctx);
		ctx.jobs.splice(0);
		const { runWorkerProgram } = await import('$lib/server/edge');
		const { Indexing } = await import('$lib/server/services/indexing');
		const runDue = () =>
			runWorkerProgram(
				ctx.env,
				Effect.flatMap(Indexing, (indexing) => indexing.runDue(10)),
				identity
			);

		// Freshly uploaded: the queue owns it, the sweep leaves it alone.
		expect(await runDue()).toBe(0);
		expect(ctx.jobs).toEqual([]);

		await queryPg(
			ctx.env,
			(sql) => sql`
				UPDATE files SET updated_at = now() - interval '20 minutes'
				WHERE id = ${file.id}`
		);
		expect(await runDue()).toBe(1);
		expect(ctx.jobs).toEqual([
			{
				body: {
					kind: 'index',
					orgId: identity.orgId,
					fileId: file.id,
					version: 1
				},
				delaySeconds: 0
			}
		]);
		// Stamped so the next tick does not re-send it again.
		expect(await runDue()).toBe(0);
	});
});
