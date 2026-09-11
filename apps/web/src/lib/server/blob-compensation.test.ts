import { describe, expect, it, vi } from 'vitest';
import { Effect } from 'effect';
import { compensateBlobFailure } from './blob-compensation';

describe('blob compensation', () => {
	it('preserves the commit failure after a failed delete is queued', async () => {
		const queued = vi.fn(() => Effect.void);
		const failure = await Effect.runPromise(
			Effect.flip(
				compensateBlobFailure(
					'commit failed',
					Effect.fail('delete failed'),
					queued,
					() => undefined
				)
			)
		);

		expect(failure).toBe('commit failed');
		expect(queued).toHaveBeenCalledOnce();
	});

	it('preserves the commit failure when both delete and queue fail', async () => {
		const report = vi.fn();
		const failure = await Effect.runPromise(
			Effect.flip(
				compensateBlobFailure(
					'commit failed',
					Effect.fail('delete failed'),
					() => Effect.fail('queue failed'),
					report
				)
			)
		);

		expect(failure).toBe('commit failed');
		expect(report).toHaveBeenCalledOnce();
	});
});
