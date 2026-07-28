import { Effect } from 'effect';
import { describe, expect, it, vi } from 'vitest';
import { runLifecycleTasks } from './lifecycle';

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
				files: task('files', 4),
				vectors: task('vectors', 5)
			})
		);
		expect(calls).toEqual([
			'authentication',
			'sites',
			'indexing',
			'files',
			'vectors'
		]);
		expect(result).toEqual({
			authentication: 1,
			sites: 2,
			indexing: 3,
			files: 4,
			vectors: 5
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
				files: Effect.succeed(0),
				vectors: Effect.succeed(0)
			})
		);
		expect(result.authentication).toBe(0);
		expect(calls).toEqual(['sites']);
		expect(error).toHaveBeenCalledOnce();
		error.mockRestore();
	});
});
