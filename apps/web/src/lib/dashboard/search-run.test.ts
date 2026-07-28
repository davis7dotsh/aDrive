import { describe, expect, it } from 'vitest';
import { isCurrentSearchRun } from './search-run';

describe('stale search result guard', () => {
	it('rejects an older completion after a newer run starts', () => {
		let current = 1;
		const older = current;
		current += 1;
		const newer = current;
		expect(isCurrentSearchRun(current, newer)).toBe(true);
		expect(isCurrentSearchRun(current, older)).toBe(false);
	});
});
