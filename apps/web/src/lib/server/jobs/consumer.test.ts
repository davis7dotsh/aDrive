import { Effect } from 'effect';
import { describe, expect, it, vi } from 'vitest';
import type { Job } from '@adrive/shared';
import { StorageError } from '../errors';
import { consumeBatch } from './consumer';

vi.mock('$app/server', () => ({ getRequestEvent: vi.fn() }));

describe('job batch consumer', () => {
	it('decodes each message, dispatches valid jobs, and acks invalid ones', async () => {
		const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
		const dispatched: Job[] = [];
		const decisions = await Effect.runPromise(
			consumeBatch(
				{
					queue: 'adrive-jobs',
					messages: [
						{
							id: 'm1',
							attempts: 1,
							body: { kind: 'index', fileId: 'file-1', version: 2 }
						},
						{ id: 'm2', attempts: 1, body: { kind: 'unknown' } },
						{ id: 'm3', attempts: 1, body: 'not json' },
						{
							id: 'm4',
							attempts: 3,
							body: { kind: 'purge', fileId: 'file-2' }
						}
					]
				},
				(job) =>
					Effect.sync(() => {
						dispatched.push(job);
					})
			)
		);

		expect(decisions).toEqual([
			{ id: 'm1', action: 'ack' },
			{ id: 'm2', action: 'ack' },
			{ id: 'm3', action: 'ack' },
			{ id: 'm4', action: 'ack' }
		]);
		expect(dispatched).toEqual([
			{ kind: 'index', fileId: 'file-1', version: 2 },
			{ kind: 'purge', fileId: 'file-2' }
		]);
		expect(
			log.mock.calls.filter(([line]) =>
				String(line).includes('job message is invalid')
			)
		).toHaveLength(2);
		log.mockRestore();
	});

	it('retries only the messages whose job failed', async () => {
		const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
		const decisions = await Effect.runPromise(
			consumeBatch(
				{
					queue: 'adrive-jobs',
					messages: [
						{
							id: 'ok',
							attempts: 1,
							body: { kind: 'site-cleanup', sessionId: 'session-1' }
						},
						{
							id: 'failing',
							attempts: 2,
							body: { kind: 'scan', fileId: 'file-3', version: 1 }
						}
					]
				},
				(job) =>
					job.kind === 'scan'
						? Effect.fail(
								new StorageError({ operation: 'scan', cause: 'unavailable' })
							)
						: Effect.void
			)
		);

		expect(decisions).toEqual([
			{ id: 'ok', action: 'ack' },
			{ id: 'failing', action: 'retry' }
		]);
		log.mockRestore();
	});
});
