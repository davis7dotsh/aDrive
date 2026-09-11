import { describe, expect, it, onTestFinished, vi } from 'vitest';
import { workOSFake } from '../services/workos';

vi.mock('$app/server', async () => {
	const { mockGetRequestEvent } = await import('../test/route-context.js');
	return mockGetRequestEvent();
});

import { call, createRouteContext } from '../test/route-context';

describe('WorkOS webhook body boundary', () => {
	it('passes the exact raw text to signature verification', async () => {
		const ctx = await createRouteContext();
		const { POST } =
			await import('../../../routes/api/webhooks/workos/+server.js');
		const constructEvent = vi.spyOn(workOSFake, 'constructEvent');
		onTestFinished(() => constructEvent.mockRestore());
		const body =
			JSON.stringify({ event: 'ignored.test', data: {} }, null, 2) + '\n';
		const signature = 't=1, v1=fake';
		const response = await call(
			POST,
			ctx.event({
				method: 'POST',
				path: '/api/webhooks/workos',
				body,
				headers: { 'workos-signature': signature }
			})
		);
		expect(response.status).toBe(200);
		expect(constructEvent).toHaveBeenCalledOnce();
		expect(constructEvent).toHaveBeenCalledWith(body, signature);
	});

	it('cancels oversized UTF-8 streams before signature verification', async () => {
		const ctx = await createRouteContext();
		const { POST } =
			await import('../../../routes/api/webhooks/workos/+server.js');
		const constructEvent = vi.spyOn(workOSFake, 'constructEvent');
		onTestFinished(() => constructEvent.mockRestore());
		const encoder = new TextEncoder();
		const chunks = ['😀'.repeat(64 * 1024), '😀', 'unread'];
		let pulls = 0;
		const cancel = vi.fn();
		const body = new ReadableStream<Uint8Array>(
			{
				pull(controller) {
					const chunk = chunks[pulls++];
					if (chunk === undefined) controller.close();
					else controller.enqueue(encoder.encode(chunk));
				},
				cancel
			},
			{ highWaterMark: 0 }
		);
		await expect(
			call(
				POST,
				ctx.event({
					method: 'POST',
					path: '/api/webhooks/workos',
					body,
					headers: { 'content-length': '1', 'workos-signature': 't=1, v1=fake' }
				})
			)
		).rejects.toMatchObject({ status: 413 });
		expect(pulls).toBe(2);
		expect(cancel).toHaveBeenCalledOnce();
		expect(body.locked).toBe(false);
		expect(constructEvent).not.toHaveBeenCalled();
	});
});
