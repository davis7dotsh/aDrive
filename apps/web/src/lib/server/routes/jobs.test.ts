import { describe, expect, it, vi } from 'vitest';
import { signJobsRequest } from '$lib/server/cron-auth';

vi.mock('$app/server', async () => {
	const { mockGetRequestEvent } = await import('../test/route-context.js');
	return mockGetRequestEvent();
});

import { call, createRouteContext } from '../test/route-context';

// The Worker facade posts queue batches here; this proves the signed path
// reaches the consumer through the real request layer and JOBS binding.
describe('queue consumer endpoint', () => {
	it('acks decoded jobs and invalid bodies, rejects bad signatures', async () => {
		const ctx = await createRouteContext();
		const { POST } =
			await import('../../../routes/api/internal/jobs/+server.js');
		const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
		const body =
			JSON.stringify(
				{
					queue: 'adrive-jobs',
					messages: [
						{
							id: 'a',
							attempts: 1,
							body: { kind: 'purge', orgId: 'org_jobs', fileId: 'file-1' }
						},
						{ id: 'b', attempts: 1, body: { kind: 'nope' } }
					]
				},
				null,
				2
			) + '\n';
		const timestamp = String(Date.now());
		const signature = await signJobsRequest(
			ctx.env.MAINTENANCE_SECRET,
			timestamp,
			body
		);
		const response = await call(
			POST,
			ctx.event({
				method: 'POST',
				path: '/api/internal/jobs',
				body,
				headers: {
					'content-type': 'application/json',
					'x-adrive-jobs-time': timestamp,
					'x-adrive-jobs-signature': signature
				}
			})
		);
		expect(response.status).toBe(200);
		await expect(response.json()).resolves.toEqual({
			decisions: [
				{ id: 'a', ack: true },
				{ id: 'b', ack: true }
			]
		});
		log.mockRestore();

		const tampered = (signature[0] === '0' ? '1' : '0') + signature.slice(1);
		await expect(
			call(
				POST,
				ctx.event({
					method: 'POST',
					path: '/api/internal/jobs',
					body,
					headers: {
						'content-type': 'application/json',
						'x-adrive-jobs-time': timestamp,
						'x-adrive-jobs-signature': tampered
					}
				})
			)
		).rejects.toMatchObject({ status: 401 });
	});

	it('rejects oversized unauthenticated UTF-8 bodies before signature verification', async () => {
		const ctx = await createRouteContext();
		const { POST } =
			await import('../../../routes/api/internal/jobs/+server.js');
		// JavaScript's character count fits the limit, while encoded bytes do not.
		const body = '😀'.repeat(256 * 1024 + 1);
		await expect(
			call(
				POST,
				ctx.event({
					method: 'POST',
					path: '/api/internal/jobs',
					body,
					headers: { 'content-length': '1' }
				})
			)
		).rejects.toMatchObject({ status: 413 });
	});

	it('records dead letters, acks them, and lists them for the owning org', async () => {
		const ctx = await createRouteContext();
		const { POST } =
			await import('../../../routes/api/internal/jobs/dead/+server.js');
		const { GET } =
			await import('../../../routes/api/admin/failed-jobs/+server.js');
		const { login, currentIdentity } = await import('../test/helpers');
		await login(ctx);
		const identity = await currentIdentity(ctx);
		const error = vi
			.spyOn(console, 'error')
			.mockImplementation(() => undefined);
		const alerts: Array<unknown> = [];
		const originalFetch = globalThis.fetch;
		globalThis.fetch = (async (
			input: RequestInfo | URL,
			init?: RequestInit
		) => {
			if (String(input) === 'https://alerts.example.test/hook') {
				alerts.push(JSON.parse(String(init?.body)));
				return new Response(null, { status: 204 });
			}
			return originalFetch(input, init);
		}) as typeof fetch;
		Object.defineProperty(ctx.env, 'ALERT_WEBHOOK_URL', {
			value: 'https://alerts.example.test/hook',
			configurable: true,
			writable: true
		});
		try {
			const messageId = `dead-${crypto.randomUUID()}`;
			const body = JSON.stringify({
				queue: 'adrive-jobs-dlq',
				messages: [
					{
						id: messageId,
						attempts: 5,
						body: {
							kind: 'index',
							orgId: identity.orgId,
							fileId: 'file-gone',
							version: 1
						}
					},
					{ id: `${messageId}-junk`, attempts: 2, body: 'junk' }
				]
			});
			const timestamp = String(Date.now());
			const signature = await signJobsRequest(
				ctx.env.MAINTENANCE_SECRET,
				timestamp,
				body
			);
			const response = await call(
				POST,
				ctx.event({
					method: 'POST',
					path: '/api/internal/jobs/dead',
					body,
					headers: {
						'content-type': 'application/json',
						'x-adrive-jobs-time': timestamp,
						'x-adrive-jobs-signature': signature
					}
				})
			);
			expect(response.status).toBe(200);
			await expect(response.json()).resolves.toEqual({
				decisions: [
					{ id: messageId, ack: true },
					{ id: `${messageId}-junk`, ack: true }
				]
			});
			expect(alerts).toEqual([
				{
					text: 'adrive: 2 job(s) dead-lettered on adrive-jobs-dlq',
					queue: 'adrive-jobs-dlq',
					recorded: 2,
					kinds: ['index', 'invalid'],
					orgIds: [identity.orgId]
				}
			]);

			const listed = await call(
				GET,
				ctx.event({ path: '/api/admin/failed-jobs' })
			);
			expect(listed.status).toBe(200);
			const { jobs } = (await listed.json()) as {
				jobs: Array<{ id: string; kind: string; attempts: number }>;
			};
			expect(jobs.map((job) => job.id)).toContain(messageId);
			expect(jobs.map((job) => job.id)).not.toContain(`${messageId}-junk`);
			expect(jobs.find((job) => job.id === messageId)).toMatchObject({
				kind: 'index',
				attempts: 5
			});
		} finally {
			globalThis.fetch = originalFetch;
			Reflect.deleteProperty(ctx.env, 'ALERT_WEBHOOK_URL');
			error.mockRestore();
		}
	});
});
