import { describe, expect, it } from 'vitest';
import { signScheduledRequest, verifyScheduledRequest } from './cron-auth';

describe('scheduled lifecycle authentication', () => {
	it('accepts only a fresh HMAC made with the deployment passcode', async () => {
		const now = Date.parse('2026-07-27T12:00:00.000Z');
		const timestamp = String(now);
		const signature = await signScheduledRequest(
			'a-long-deployment-passcode',
			timestamp,
			'*/5 * * * *'
		);
		await expect(
			verifyScheduledRequest(
				'a-long-deployment-passcode',
				timestamp,
				'*/5 * * * *',
				signature,
				now
			)
		).resolves.toBe(true);
		await expect(
			verifyScheduledRequest(
				'wrong-deployment-passcode',
				timestamp,
				'*/5 * * * *',
				signature,
				now
			)
		).resolves.toBe(false);
	});

	it('rejects missing, malformed, altered, and replayed signatures', async () => {
		const now = Date.parse('2026-07-27T12:00:00.000Z');
		const timestamp = String(now);
		const signature = await signScheduledRequest(
			'a-long-deployment-passcode',
			timestamp,
			'*/5 * * * *'
		);
		await expect(
			verifyScheduledRequest(
				'a-long-deployment-passcode',
				null,
				null,
				null,
				now
			)
		).resolves.toBe(false);
		await expect(
			verifyScheduledRequest(
				'a-long-deployment-passcode',
				timestamp,
				'0 * * * *',
				signature,
				now
			)
		).resolves.toBe(false);
		await expect(
			verifyScheduledRequest(
				'a-long-deployment-passcode',
				timestamp,
				'*/5 * * * *',
				'not-a-signature',
				now
			)
		).resolves.toBe(false);
		await expect(
			verifyScheduledRequest(
				'a-long-deployment-passcode',
				timestamp,
				'*/5 * * * *',
				signature,
				now + 6 * 60 * 1_000
			)
		).resolves.toBe(false);
	});
});
