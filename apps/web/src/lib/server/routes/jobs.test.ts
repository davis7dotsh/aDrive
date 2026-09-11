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
						{ id: 'a', attempts: 1, body: { kind: 'purge', fileId: 'file-1' } },
						{ id: 'b', attempts: 1, body: { kind: 'nope' } }
					]
				},
				null,
				2
			) + '\n';
		const timestamp = String(Date.now());
		const signature = await signJobsRequest(ctx.env.PASSCODE, timestamp, body);
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
				{ id: 'a', action: 'ack' },
				{ id: 'b', action: 'ack' }
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
});
