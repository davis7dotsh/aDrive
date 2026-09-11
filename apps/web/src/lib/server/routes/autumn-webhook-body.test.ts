import { describe, expect, it, vi } from 'vitest';
import { signSvix } from '../svix';

vi.mock('$app/server', async () => {
	const { mockGetRequestEvent } = await import('../test/route-context.js');
	return mockGetRequestEvent();
});

import { call, createRouteContext } from '../test/route-context';

describe('Autumn webhook body boundary', () => {
	it('verifies the exact raw text including whitespace', async () => {
		const ctx = await createRouteContext();
		const { POST } =
			await import('../../../routes/api/webhooks/autumn/+server.js');
		const body =
			JSON.stringify({ type: 'ignored.test', data: {} }, null, 2) + '\n';
		const id = `msg_${crypto.randomUUID()}`;
		const timestamp = String(Math.floor(Date.now() / 1000));
		const signature = await signSvix(
			ctx.env.AUTUMN_WEBHOOK_SECRET ?? '',
			id,
			timestamp,
			body
		);
		const response = await call(
			POST,
			ctx.event({
				method: 'POST',
				path: '/api/webhooks/autumn',
				body,
				headers: {
					'svix-id': id,
					'svix-timestamp': timestamp,
					'svix-signature': signature ?? ''
				}
			})
		);
		expect(response.status).toBe(200);
	});

	it('cancels an oversized UTF-8 stream before checking its missing signature', async () => {
		const ctx = await createRouteContext();
		const { POST } =
			await import('../../../routes/api/webhooks/autumn/+server.js');
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
					path: '/api/webhooks/autumn',
					body,
					headers: { 'content-length': '1' }
				})
			)
		).rejects.toMatchObject({ status: 413 });
		expect(pulls).toBe(2);
		expect(cancel).toHaveBeenCalledOnce();
		expect(body.locked).toBe(false);
	});
});
