import { Effect } from 'effect';
import { describe, expect, it, vi } from 'vitest';
import { runLifecycleTasks, summarize } from './lifecycle';

describe('scheduled lifecycle orchestration', () => {
	it('runs every bounded task and returns aggregate counts', async () => {
		const calls: string[] = [];
		const task = (name: string, count: number) =>
			Effect.sync(() => {
				calls.push(name);
				return count;
			});
		const result = await Effect.runPromise(
			runLifecycleTasks({
				authentication: task('authentication', 1),
				sites: task('sites', 2),
				indexing: task('indexing', 3),
				scans: task('scans', 5),
				usage: task('usage', 6),
				files: task('files', 4)
			})
		);
		expect(calls).toEqual([
			'authentication',
			'sites',
			'indexing',
			'scans',
			'usage',
			'files'
		]);
		expect(result).toEqual({
			authentication: 1,
			sites: 2,
			indexing: 3,
			scans: 5,
			usage: 6,
			files: 4
		});
	});

	it('isolates one failed task so later cleanup still runs', async () => {
		const error = vi.spyOn(console, 'error').mockImplementation(() => {});
		const calls: string[] = [];
		const result = await Effect.runPromise(
			runLifecycleTasks({
				authentication: Effect.fail('database unavailable'),
				sites: Effect.sync(() => {
					calls.push('sites');
					return 1;
				}),
				indexing: Effect.succeed(0),
				scans: Effect.succeed(0),
				usage: Effect.succeed(0),
				files: Effect.succeed(0)
			})
		);
		expect(result.authentication).toBe(0);
		expect(calls).toEqual(['sites']);
		expect(error).toHaveBeenCalledOnce();
		error.mockRestore();
	});

	it('sums per-org sweeps beneath the global count', () => {
		expect(
			summarize(7, [
				{
					authentication: 0,
					sites: 1,
					indexing: 2,
					scans: 4,
					usage: 1,
					files: 3
				},
				{
					authentication: 0,
					sites: 4,
					indexing: 5,
					scans: 7,
					usage: 2,
					files: 6
				}
			])
		).toEqual({
			authentication: 7,
			sites: 5,
			indexing: 7,
			scans: 11,
			usage: 3,
			files: 9
		});
	});
});
