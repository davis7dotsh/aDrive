import { describe, expect, it, vi } from 'vitest';
import { verifyJobsRequest } from '../src/lib/server/cron-auth';
import type { JobDecision } from '../src/lib/server/jobs/consumer';
import { facadeSource } from './cloudflare-adapter.mjs';

const generatedQueue = (
	fetch: (request: Request, env: object, ctx: object) => Promise<Response>
) => {
	const executable = facadeSource('_sveltekit.js')
		.replace('import sveltekit from "./_sveltekit.js";', '')
		.replace('export * from "./_sveltekit.js";', '')
		.replace('export default', 'return');
	const facade: unknown = new Function('sveltekit', executable)({ fetch });
	if (
		typeof facade !== 'object' ||
		facade === null ||
		!('queue' in facade) ||
		typeof facade.queue !== 'function'
	) {
		throw new Error('Generated facade does not expose a queue handler');
	}
	return facade.queue;
};

describe('Cloudflare Worker facade', () => {
	it('delegates fetch and exports a signed scheduled handler', () => {
		const source = facadeSource('_sveltekit.js');
		expect(source).toContain('return sveltekit.fetch(request, env, ctx)');
		expect(source).toContain('scheduled(controller, env, ctx)');
		expect(source).toContain('async queue(batch, env, ctx)');
		expect(source).toContain("'/api/internal/jobs'");
		expect(source).toContain("'/api/internal/jobs/dead'");
		expect(source).toContain("batch.queue.endsWith('-dlq')");
		expect(source).toContain('message.ack()');
		expect(source).toContain('message.retry()');
		expect(source).toContain(
			'message.retry({ delaySeconds: decision.delaySeconds })'
		);
		expect(source).toContain("name: 'HMAC', hash: 'SHA-256'");
		expect(source).toContain('ctx.waitUntil(');
		expect(source).not.toContain('const { waitUntil } = ctx');
		expect(source).not.toContain('PASSCODE');
		expect(source).toContain('env.MAINTENANCE_SECRET');
		const executable = source
			.replace(
				'import sveltekit from "./_sveltekit.js";',
				'const sveltekit = {};'
			)
			.replace('export * from "./_sveltekit.js";', '')
			.replace('export default', 'return');
		expect(() => new Function(executable)).not.toThrow();
	});

	it('signs the forwarded batch and applies explicit and missing decisions', async () => {
		const env = {
			DASHBOARD_ORIGIN: 'https://dashboard.test',
			MAINTENANCE_SECRET: 'facade-signature-test-secret'
		};
		const ctx = { waitUntil: vi.fn() };
		const messages = ['acknowledged', 'retrying', 'undecided'].map((id) => ({
			id,
			attempts: 2,
			body: { kind: 'purge', fileId: `file-${id}` },
			ack: vi.fn(),
			retry: vi.fn()
		}));
		const batch = { queue: 'adrive-jobs', messages };
		const fetch = vi.fn(
			async (request: Request, receivedEnv: object, receivedCtx: object) => {
				expect(request.url).toBe('https://dashboard.test/api/internal/jobs');
				expect(request.method).toBe('POST');
				expect(request.headers.get('content-type')).toBe('application/json');
				expect(receivedEnv).toBe(env);
				expect(receivedCtx).toBe(ctx);
				const body = await request.text();
				expect(body).toBe(
					JSON.stringify({
						queue: batch.queue,
						messages: messages.map(({ id, attempts, body }) => ({
							id,
							attempts,
							body
						}))
					})
				);
				await expect(
					verifyJobsRequest(
						env.MAINTENANCE_SECRET,
						request.headers.get('x-adrive-jobs-time'),
						body,
						request.headers.get('x-adrive-jobs-signature')
					)
				).resolves.toBe(true);
				return Response.json({
					decisions: [
						{ id: 'acknowledged', ack: true },
						{ id: 'retrying', retry: true, delaySeconds: 120 }
					] satisfies ReadonlyArray<JobDecision>
				});
			}
		);
		await generatedQueue(fetch)(batch, env, ctx);
		expect(fetch).toHaveBeenCalledOnce();
		for (const message of messages) {
			expect(message.ack).toHaveBeenCalledTimes(
				message.id === 'acknowledged' ? 1 : 0
			);
			expect(message.retry).toHaveBeenCalledTimes(
				message.id === 'acknowledged' ? 0 : 1
			);
			if (message.id === 'retrying') {
				expect(message.retry).toHaveBeenCalledWith({ delaySeconds: 120 });
			} else if (message.id === 'undecided') {
				expect(message.retry).toHaveBeenCalledWith();
			}
		}
	});

	it.each([401, 503])(
		'throws on endpoint status %s so Cloudflare retries the batch',
		async (status) => {
			const message = {
				id: 'unacknowledged',
				attempts: 1,
				body: { kind: 'purge', fileId: 'file-1' },
				ack: vi.fn(),
				retry: vi.fn()
			};
			const fetch = vi.fn(async () => new Response(null, { status }));
			await expect(
				generatedQueue(fetch)(
					{ queue: 'adrive-jobs', messages: [message] },
					{
						DASHBOARD_ORIGIN: 'https://dashboard.test',
						MAINTENANCE_SECRET: 'facade-signature-test-secret'
					},
					{}
				)
			).rejects.toThrow(`Queue consumer failed with status ${status}`);
			expect(message.ack).not.toHaveBeenCalled();
			expect(message.retry).not.toHaveBeenCalled();
		}
	);
});
