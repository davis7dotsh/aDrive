import { describe, expect, it } from 'vitest';
import {
	LAST_USED_TOUCH_INTERVAL_MS,
	allowsCredentialOrigin,
	bearerToken,
	normalizeUserCode,
	shouldCountDownload,
	shouldRecordFileDownload,
	shouldTouchLastUsed,
	validateExpiration
} from './auth-policy';

describe('auth policy', () => {
	it('normalizes device approval codes', () => {
		expect(normalizeUserCode('abcd-1234')).toBe('ABCD-1234');
	});

	it('accepts only future expiration timestamps', () => {
		expect(validateExpiration(null)).toBeNull();
		expect(() =>
			validateExpiration('2025-01-01', new Date('2026-01-01'))
		).toThrow();
		expect(
			validateExpiration('2027-01-01T00:00:00Z', new Date('2026-01-01'))
		).toBe('2027-01-01T00:00:00.000Z');
	});

	it('counts full downloads and only the initial byte range', () => {
		expect(shouldCountDownload(null)).toBe(true);
		expect(shouldCountDownload('bytes=0-')).toBe(true);
		expect(shouldCountDownload('bytes=0-999')).toBe(true);
		expect(shouldCountDownload('bytes=1000-1999')).toBe(false);
		expect(shouldCountDownload('bytes=-500')).toBe(false);
	});

	it('does not count an internal thumbnail read as a download', () => {
		expect(shouldRecordFileDownload(null, true)).toBe(false);
		expect(shouldRecordFileDownload('bytes=0-999', true)).toBe(false);
		expect(shouldRecordFileDownload(null, false)).toBe(true);
	});

	it('touches last-used timestamps only after the idle interval', () => {
		const now = new Date('2026-08-18T12:00:00.000Z');
		expect(shouldTouchLastUsed(null, now)).toBe(true);
		expect(shouldTouchLastUsed('not-a-date', now)).toBe(true);
		expect(
			shouldTouchLastUsed(
				new Date(now.getTime() - LAST_USED_TOUCH_INTERVAL_MS + 1).toISOString(),
				now
			)
		).toBe(false);
		expect(
			shouldTouchLastUsed(
				new Date(now.getTime() - LAST_USED_TOUCH_INTERVAL_MS).toISOString(),
				now
			)
		).toBe(true);
	});

	it('reads Bearer tokens without regard to scheme case', () => {
		expect(bearerToken('Bearer adr_abc_secret')).toBe('adr_abc_secret');
		expect(bearerToken('bearer adr_abc_secret')).toBe('adr_abc_secret');
		expect(bearerToken('BEARER adr_abc_secret')).toBe('adr_abc_secret');
		expect(bearerToken(' Bearer adr_abc_secret ')).toBe('adr_abc_secret');
		expect(bearerToken('Basic abc')).toBe('');
		expect(bearerToken('Bearer')).toBe('');
		expect(bearerToken(null)).toBe('');
	});

	it('requires the dashboard origin for cookie-authenticated mutations', () => {
		expect(allowsCredentialOrigin('GET', null, 'https://drive.example')).toBe(
			true
		);
		expect(
			allowsCredentialOrigin(
				'DELETE',
				'https://drive.example',
				'https://drive.example'
			)
		).toBe(true);
		expect(
			allowsCredentialOrigin(
				'POST',
				'https://sibling.example',
				'https://drive.example'
			)
		).toBe(false);
	});
});
