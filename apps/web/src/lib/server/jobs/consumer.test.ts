import { Effect } from 'effect';
import { describe, expect, it, vi } from 'vitest';
import type { Job } from '@adrive/shared';
import { StorageError } from '../errors';
import { consumeBatch, dispatchJob, liveJobHandlers } from './consumer';
import { Indexing, type IndexingShape } from '../services/indexing';

vi.mock('$app/server', () => ({ getRequestEvent: vi.fn() }));

const quiet = () => {
	const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
	return () => log.mockRestore();
};

describe('job batch consumer', () => {
	it('decodes each message, dispatches valid jobs, and acks invalid ones', async () => {
		const restore = quiet();
		const dispatched: Job[] = [];
		const decisions = await Effect.runPromise(
			consumeBatch(
				{
					queue: 'adrive-jobs',
					messages: [
						{
							id: 'm1',
							attempts: 1,
							body: {
								kind: 'index',
								orgId: 'org-1',
								fileId: 'file-1',
								version: 2
							}
						},
						{ id: 'm2', attempts: 1, body: { kind: 'unknown' } },
						{ id: 'm3', attempts: 1, body: 'not json' },
						// Jobs from before orgId was required no longer decode.
						{
							id: 'm4',
							attempts: 3,
							body: { kind: 'purge', fileId: 'file-2' }
						},
						{
							id: 'm5',
							attempts: 3,
							body: { kind: 'purge', orgId: 'org-1', fileId: 'file-2' }
						}
					]
				},
				(job) =>
					Effect.sync(() => {
						dispatched.push(job);
						return 'done' as const;
					})
			)
		);

		expect(decisions).toEqual([
			{ id: 'm1', ack: true },
			{ id: 'm2', ack: true },
			{ id: 'm3', ack: true },
			{ id: 'm4', ack: true },
			{ id: 'm5', ack: true }
		]);
		expect(dispatched).toEqual([
			{ kind: 'index', orgId: 'org-1', fileId: 'file-1', version: 2 },
			{ kind: 'purge', orgId: 'org-1', fileId: 'file-2' }
		]);
		restore();
	});

	it('retries failed jobs with a delay that grows per delivery', async () => {
		const restore = quiet();
		const failing = (job: Job) =>
			job.kind === 'scan'
				? Effect.fail(
						new StorageError({ operation: 'scan', cause: 'unavailable' })
					)
				: Effect.succeed('done' as const);
		const batch = (attempts: number) => ({
			queue: 'adrive-jobs',
			messages: [
				{
					id: 'ok',
					attempts,
					body: { kind: 'site-cleanup', orgId: 'org-1', sessionId: 's-1' }
				},
				{
					id: 'failing',
					attempts,
					body: { kind: 'scan', orgId: 'org-1', fileId: 'file-3', version: 1 }
				}
			]
		});

		await expect(
			Effect.runPromise(consumeBatch(batch(1), failing))
		).resolves.toEqual([
			{ id: 'ok', ack: true },
			{ id: 'failing', retry: true, delaySeconds: 60 }
		]);
		await expect(
			Effect.runPromise(consumeBatch(batch(4), failing))
		).resolves.toEqual([
			{ id: 'ok', ack: true },
			{ id: 'failing', retry: true, delaySeconds: 480 }
		]);
		await expect(
			Effect.runPromise(consumeBatch(batch(12), failing))
		).resolves.toEqual([
			{ id: 'ok', ack: true },
			{ id: 'failing', retry: true, delaySeconds: 3600 }
		]);
		restore();
	});

	it('retries when a handler asks for another run', async () => {
		const restore = quiet();
		const decisions = await Effect.runPromise(
			consumeBatch(
				{
					queue: 'adrive-jobs',
					messages: [
						{
							id: 'again',
							attempts: 2,
							body: {
								kind: 'index',
								orgId: 'org-1',
								fileId: 'file-1',
								version: 1
							}
						}
					]
				},
				() => Effect.succeed('retry' as const)
			)
		);
		expect(decisions).toEqual([
			{ id: 'again', retry: true, delaySeconds: 120 }
		]);
		restore();
	});

	it('dispatches each kind to its handler', async () => {
		const calls: string[] = [];
		const handler =
			(name: string, outcome: 'done' | 'retry' = 'done') =>
			(job: Job) =>
				Effect.sync(() => {
					calls.push(`${name}:${job.orgId}`);
					return outcome;
				});
		const run = dispatchJob({
			index: handler('index', 'retry'),
			scan: handler('scan'),
			purge: handler('purge'),
			siteCleanup: handler('site-cleanup')
		});

		expect(
			await Effect.runPromise(
				run({ kind: 'index', orgId: 'a', fileId: 'f', version: 1 })
			)
		).toBe('retry');
		expect(
			await Effect.runPromise(
				run({ kind: 'site-cleanup', orgId: 'b', sessionId: 's' })
			)
		).toBe('done');
		expect(
			await Effect.runPromise(run({ kind: 'purge', orgId: 'c', fileId: 'f' }))
		).toBe('done');
		expect(calls).toEqual(['index:a', 'site-cleanup:b', 'purge:c']);
	});

	it('asks for a redelivery only when indexing could not run', async () => {
		const outcomes: Array<'indexed' | 'skipped' | 'retry' | 'failed'> = [
			'indexed',
			'skipped',
			'failed',
			'retry'
		];
		const indexing = Indexing.of({
			runOne: () => Effect.succeed(outcomes.shift() ?? 'skipped'),
			enqueue: () => Effect.void,
			process: () => Effect.void,
			runDue: () => Effect.succeed(0),
			status: Effect.die('unused')
		} satisfies IndexingShape);
		const handlers = await Effect.runPromise(
			liveJobHandlers.pipe(Effect.provideService(Indexing, indexing))
		);
		const run = () =>
			Effect.runPromise(
				handlers.index({ kind: 'index', orgId: 'o', fileId: 'f', version: 3 })
			);

		expect(await run()).toBe('done');
		expect(await run()).toBe('done');
		expect(await run()).toBe('done');
		expect(await run()).toBe('retry');
	});
});
