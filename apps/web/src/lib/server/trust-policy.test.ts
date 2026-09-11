import { describe, expect, it } from 'vitest';
import {
	canPublish,
	establishedCutoff,
	parseTrust,
	publishLimitPerHour,
	scanBeforePublish
} from './trust-policy';

describe('trust policy', () => {
	it('lets verified and established orgs publish, never new or suspended', () => {
		expect(canPublish('new')).toBe(false);
		expect(canPublish('verified')).toBe(true);
		expect(canPublish('established')).toBe(true);
		expect(canPublish('suspended')).toBe(false);
	});

	it('holds a verified publish for the scanner and lets established through', () => {
		expect(scanBeforePublish('verified')).toBe(true);
		expect(scanBeforePublish('established')).toBe(false);
		expect(scanBeforePublish('new')).toBe(false);
	});

	it('grows the publish budget with trust', () => {
		expect(publishLimitPerHour('new')).toBe(0);
		expect(publishLimitPerHour('suspended')).toBe(0);
		expect(publishLimitPerHour('verified')).toBeLessThan(
			publishLimitPerHour('established')
		);
	});

	it('reads unknown column values as new', () => {
		expect(parseTrust('established')).toBe('established');
		expect(parseTrust('trusted')).toBe('new');
	});

	it('cuts the established sweep off 14 days back', () => {
		expect(establishedCutoff(new Date('2026-03-15T00:00:00.000Z'))).toBe(
			'2026-03-01T00:00:00.000Z'
		);
	});
});
