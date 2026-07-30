import { describe, expect, it } from 'vitest';
import {
	allowsCredentialOrigin,
	normalizeUserCode,
	shouldCountDownload,
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
