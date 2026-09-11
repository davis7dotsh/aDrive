import { describe, expect, it } from 'vitest';
import {
	MAX_JOB_DELAY_SECONDS,
	delaySecondsUntil,
	retryDelaySeconds,
	stuckBefore
} from './job-policy';

describe('job timing policy', () => {
	it('delays until the target, capped at the queue maximum', () => {
		const now = Date.parse('2026-07-27T00:00:00.000Z');
		expect(delaySecondsUntil('2026-07-27T00:00:30.000Z', now)).toBe(30);
		expect(delaySecondsUntil('2026-07-27T00:00:00.400Z', now)).toBe(1);
		expect(delaySecondsUntil('2026-07-26T00:00:00.000Z', now)).toBe(0);
		expect(delaySecondsUntil('2026-09-01T00:00:00.000Z', now)).toBe(
			MAX_JOB_DELAY_SECONDS
		);
		expect(delaySecondsUntil('not a date', now)).toBe(0);
	});

	it('doubles the retry delay per delivery up to an hour', () => {
		expect(retryDelaySeconds(0)).toBe(30);
		expect(retryDelaySeconds(1)).toBe(60);
		expect(retryDelaySeconds(2)).toBe(120);
		expect(retryDelaySeconds(5)).toBe(960);
		expect(retryDelaySeconds(20)).toBe(3_600);
	});

	it('marks rows stuck fifteen minutes after they were due', () => {
		expect(stuckBefore(Date.parse('2026-07-27T01:00:00.000Z'))).toBe(
			'2026-07-27T00:45:00.000Z'
		);
	});
});
