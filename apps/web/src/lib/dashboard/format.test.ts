import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { toLocalDateTimeInput } from './format';

const previousTimezone = process.env.TZ;

beforeAll(() => {
	process.env.TZ = 'America/Los_Angeles';
});

afterAll(() => {
	if (previousTimezone === undefined) {
		delete process.env.TZ;
	} else {
		process.env.TZ = previousTimezone;
	}
});

describe('datetime-local formatting', () => {
	it('round-trips an instant through Los Angeles wall-clock minutes', () => {
		const instant = '2026-07-27T20:30:00.000Z';
		const input = toLocalDateTimeInput(instant);

		expect(input).toBe('2026-07-27T13:30');
		expect(new Date(input).toISOString()).toBe(instant);
	});

	it('returns an empty input value for absent or invalid instants', () => {
		expect(toLocalDateTimeInput(null)).toBe('');
		expect(toLocalDateTimeInput(undefined)).toBe('');
		expect(toLocalDateTimeInput('not-a-date')).toBe('');
	});
});
