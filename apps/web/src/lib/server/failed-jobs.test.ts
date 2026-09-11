import { Effect } from 'effect';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { postFailedJobAlert } from './failed-jobs';

const summary = {
	queue: 'test-dlq',
	recorded: 1,
	kinds: ['index'],
	orgIds: ['org_test']
};
afterEach(() => vi.restoreAllMocks());

describe('best-effort failed job alerts', () => {
	it('logs HTTP errors without failing the durable dead-letter operation', async () => {
		vi.spyOn(globalThis, 'fetch').mockResolvedValue(
			new Response('Unavailable', { status: 503 })
		);
		const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
		await expect(
			Effect.runPromise(
				postFailedJobAlert('https://alerts.example.test', summary)
			)
		).resolves.toBeUndefined();
		expect(log).toHaveBeenCalledOnce();
		expect(log.mock.calls[0]?.[0]).toContain('HTTP 503');
	});

	it('aborts a stalled alert and lets the durable dead-letter operation finish', async () => {
		const controller = new AbortController();
		vi.spyOn(AbortSignal, 'timeout').mockReturnValue(controller.signal);
		const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
		const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(
			(_url, init) =>
				new Promise<Response>((_resolve, reject) => {
					init?.signal?.addEventListener(
						'abort',
						() => reject(new DOMException('Timed out', 'TimeoutError')),
						{ once: true }
					);
				})
		);
		const running = Effect.runPromise(
			postFailedJobAlert('https://alerts.example.test', summary)
		);
		await vi.waitFor(() => expect(fetch).toHaveBeenCalledOnce());
		controller.abort();
		await expect(running).resolves.toBeUndefined();
		expect(log).toHaveBeenCalledOnce();
	});
});
