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
	listFiles,
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
		// A public upload is indexed and scanned.
		expect(ctx.jobs).toEqual([
			{
				body: {
					kind: 'index',
					orgId: identity.orgId,
					fileId: file.id,
					version: 1
				},
				delaySeconds: 0
			},
			{
				body: {
					kind: 'scan',
					orgId: identity.orgId,
					fileId: file.id,
					version: 1
				},
				delaySeconds: 0
			}
		]);
		expect((await fileDetail(ctx, file.id)).indexState).toBe('pending');

		const decisions = await ctx.drainJobs();
		expect(decisions).toEqual([
			{ id: 'test-1', ack: true },
			{ id: 'test-2', ack: true }
		]);
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
			{ id: 'test-2', ack: true },
			{ id: 'test-3', ack: true }
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
		expect(
			ctx.jobs.map((job) => job.body).filter((job) => job.kind === 'index')
		).toMatchObject([
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

describe('queue-driven purges and site cleanup (local platform)', () => {
	let shared: RouteTestContext | undefined;
	const setup = async () => {
		shared ??= await createRouteContext();
		shared.jobs.splice(0);
		return shared;
	};

	const purgeJobs = (ctx: RouteTestContext, fileId: string) =>
		ctx.jobs.filter(
			(job) => job.body.kind === 'purge' && job.body.fileId === fileId
		);

	it('trashing sends a delayed purge that re-sends itself until the retention is up', async () => {
		const ctx = await setup();
		await login(ctx);
		const file = await uploadFile(ctx, { name: 'retained.txt' });
		const { MAX_JOB_DELAY_SECONDS } = await import('$lib/server/job-policy');

		await mutateFile(ctx, file.id, { action: 'trash' });
		// Thirty days of retention is capped at the queue's maximum delay.
		expect(purgeJobs(ctx, file.id).map((job) => job.delaySeconds)).toEqual([
			MAX_JOB_DELAY_SECONDS
		]);

		// Delivered early: the file stays and the job is sent again for
		// the remaining window.
		await ctx.drainJobs();
		expect(purgeJobs(ctx, file.id).map((job) => job.delaySeconds)).toEqual([
			MAX_JOB_DELAY_SECONDS
		]);
		const trashed = await listFiles(ctx);
		expect(trashed.files.map((entry) => entry.id)).not.toContain(file.id);
		const row = await queryPg(
			ctx.env,
			(sql) => sql<{ purge_state: string }>`
				SELECT purge_state FROM files WHERE id = ${file.id}`
		);
		expect(row[0]?.purge_state).toBe('none');

		// Shorten the retention to a moment ago and the next delivery
		// purges for real.
		await queryPg(
			ctx.env,
			(sql) => sql`
				UPDATE files SET purge_at = now() - interval '1 second'
				WHERE id = ${file.id}`
		);
		await ctx.drainJobs();
		expect(
			await queryPg(
				ctx.env,
				(sql) => sql<{ id: string }>`SELECT id FROM files WHERE id = ${file.id}`
			)
		).toEqual([]);
		expect(purgeJobs(ctx, file.id)).toEqual([]);
	});

	it('an expiry set on upload purges the file once it passes', async () => {
		const ctx = await setup();
		await login(ctx);
		const expiresAt = new Date(Date.now() + 2 * 60_000).toISOString();
		const { PUT } = await import('../../../routes/api/files/+server.js');
		const response = await call(
			PUT,
			ctx.event({
				method: 'PUT',
				path: '/api/files',
				body: 'short lived',
				headers: {
					'content-type': 'text/plain',
					'x-adrive-file-name': 'ephemeral.txt',
					'x-adrive-expires-at': expiresAt
				}
			})
		);
		expect(response.status).toBe(201);
		const { file } = (await response.json()) as { file: { id: string } };
		const [purge] = purgeJobs(ctx, file.id);
		expect(purge?.delaySeconds).toBeGreaterThan(100);
		expect(purge?.delaySeconds).toBeLessThanOrEqual(120);

		await queryPg(
			ctx.env,
			(sql) => sql`
				UPDATE files SET expires_at = now() - interval '1 second'
				WHERE id = ${file.id}`
		);
		await ctx.drainJobs();
		expect(
			await queryPg(
				ctx.env,
				(sql) => sql<{ id: string }>`SELECT id FROM files WHERE id = ${file.id}`
			)
		).toEqual([]);
	});

	it('a restored file is left alone by its stale purge job', async () => {
		const ctx = await setup();
		await login(ctx);
		const file = await uploadFile(ctx, { name: 'second-thoughts.txt' });
		await mutateFile(ctx, file.id, { action: 'trash' });
		await mutateFile(ctx, file.id, { action: 'restore' });
		expect(purgeJobs(ctx, file.id)).toHaveLength(1);

		await ctx.drainJobs();
		expect(purgeJobs(ctx, file.id)).toEqual([]);
		const listed = await listFiles(ctx);
		expect(listed.files.map((entry) => entry.id)).toContain(file.id);
	});

	it('re-sends purge jobs the queue lost and leaves fresh ones alone', async () => {
		const ctx = await setup();
		await login(ctx);
		const file = await uploadFile(ctx, { name: 'forgotten.txt' });
		await mutateFile(ctx, file.id, { action: 'trash' });
		const identity = await currentIdentity(ctx);
		ctx.jobs.splice(0);
		const { runWorkerProgram } = await import('$lib/server/edge');
		const { Files } = await import('$lib/server/services/files');
		const sweep = () =>
			runWorkerProgram(
				ctx.env,
				Effect.flatMap(Files, (files) => files.sweepPurges(10)),
				identity
			);

		expect(await sweep()).toBe(0);
		await queryPg(
			ctx.env,
			(sql) => sql`
				UPDATE files SET purge_at = now() - interval '20 minutes'
				WHERE id = ${file.id}`
		);
		expect(await sweep()).toBe(1);
		expect(ctx.jobs).toEqual([
			{
				body: { kind: 'purge', orgId: identity.orgId, fileId: file.id },
				delaySeconds: 0
			}
		]);
		expect(await sweep()).toBe(0);
		await ctx.drainJobs();
		expect(
			await queryPg(
				ctx.env,
				(sql) => sql<{ id: string }>`SELECT id FROM files WHERE id = ${file.id}`
			)
		).toEqual([]);
	});

	it('an abandoned site session is aborted once its TTL is up', async () => {
		const ctx = await setup();
		await login(ctx);
		const { POST } =
			await import('../../../routes/api/sites/sessions/+server.js');
		const created = await call(
			POST,
			ctx.event({
				method: 'POST',
				path: '/api/sites/sessions',
				body: JSON.stringify({
					displayName: 'abandoned-site',
					assets: [
						{ path: 'index.html', sizeBytes: 4, contentType: 'text/html' }
					]
				}),
				headers: { 'content-type': 'application/json' }
			})
		);
		expect(created.status).toBe(201);
		const session = (await created.json()) as { sessionId: string };
		const identity = await currentIdentity(ctx);
		expect(ctx.jobs).toEqual([
			{
				body: {
					kind: 'site-cleanup',
					orgId: identity.orgId,
					sessionId: session.sessionId
				},
				delaySeconds: 3600
			}
		]);
		const { PUT } =
			await import('../../../routes/api/sites/sessions/[id]/assets/+server.js');
		const staged = await call(
			PUT,
			ctx.event({
				method: 'PUT',
				path: `/api/sites/sessions/${session.sessionId}/assets?path=index.html`,
				body: '<h1>',
				headers: { 'content-type': 'text/html' },
				params: { id: session.sessionId }
			})
		);
		expect(staged.status).toBe(201);
		const stagedKey = (
			await queryPg(
				ctx.env,
				(sql) => sql<{ r2_key: string | null }>`
					SELECT r2_key FROM staged_site_assets
					WHERE session_id = ${session.sessionId}`
			)
		)[0]?.r2_key;
		expect(stagedKey).toBeTruthy();

		// Early delivery: still open, still within its TTL, so it is
		// re-sent for the expiry and nothing is touched.
		await ctx.drainJobs();
		expect(ctx.jobs.map((job) => job.body.kind)).toEqual(['site-cleanup']);
		expect(
			(
				await queryPg(
					ctx.env,
					(sql) => sql<{ status: string }>`
						SELECT status FROM site_upload_sessions
						WHERE id = ${session.sessionId}`
				)
			)[0]?.status
		).toBe('open');

		await queryPg(
			ctx.env,
			(sql) => sql`
				UPDATE site_upload_sessions SET expires_at = now() - interval '1 second'
				WHERE id = ${session.sessionId}`
		);
		await ctx.drainJobs();
		expect(ctx.jobs).toEqual([]);
		expect(
			(
				await queryPg(
					ctx.env,
					(sql) => sql<{ status: string }>`
						SELECT status FROM site_upload_sessions
						WHERE id = ${session.sessionId}`
				)
			)[0]?.status
		).toBe('aborted');
		expect(
			stagedKey ? await ctx.env.BUCKET.head(stagedKey) : undefined
		).toBeNull();
	});
});
