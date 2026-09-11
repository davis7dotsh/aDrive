import { describe, expect, it } from 'vitest';
import { signScheduledRequest, verifyScheduledRequest } from './cron-auth';

describe('scheduled lifecycle authentication', () => {
	it('accepts only a fresh HMAC made with the deployment secret', async () => {
		const now = Date.parse('2026-07-27T12:00:00.000Z');
		const timestamp = String(now);
		const signature = await signScheduledRequest(
			'a-long-deployment-secret',
			timestamp,
			'*/5 * * * *'
		);
		await expect(
			verifyScheduledRequest(
				'a-long-deployment-secret',
				timestamp,
				'*/5 * * * *',
				signature,
				now
			)
		).resolves.toBe(true);
		await expect(
			verifyScheduledRequest(
				'wrong-deployment-secret',
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
			'a-long-deployment-secret',
			timestamp,
			'*/5 * * * *'
		);
		await expect(
			verifyScheduledRequest('a-long-deployment-secret', null, null, null, now)
		).resolves.toBe(false);
		await expect(
			verifyScheduledRequest(
				'a-long-deployment-secret',
				timestamp,
				'0 * * * *',
				signature,
				now
			)
		).resolves.toBe(false);
		await expect(
			verifyScheduledRequest(
				'a-long-deployment-secret',
				timestamp,
				'*/5 * * * *',
				'not-a-signature',
				now
			)
		).resolves.toBe(false);
		await expect(
			verifyScheduledRequest(
				'a-long-deployment-secret',
				timestamp,
				'*/5 * * * *',
				signature,
				now + 6 * 60 * 1_000
			)
		).resolves.toBe(false);
	});
});

describe('queue delivery authentication', () => {
	it('binds the signature to the timestamp and the exact body', async () => {
		const { signJobsRequest, verifyJobsRequest } = await import('./cron-auth');
		const now = Date.parse('2026-07-27T12:00:00.000Z');
		const timestamp = String(now);
		const body = '{"queue":"adrive-jobs","messages":[]}';
		const signature = await signJobsRequest(
			'a-long-deployment-secret',
			timestamp,
			body
		);
		await expect(
			verifyJobsRequest(
				'a-long-deployment-secret',
				timestamp,
				body,
				signature,
				now
			)
		).resolves.toBe(true);
		await expect(
			verifyJobsRequest(
				'a-long-deployment-secret',
				timestamp,
				'{"queue":"adrive-jobs","messages":[{}]}',
				signature,
				now
			)
		).resolves.toBe(false);
		await expect(
			verifyJobsRequest(
				'a-long-deployment-secret',
				timestamp,
				body,
				signature,
				now + 6 * 60 * 1_000
			)
		).resolves.toBe(false);
		await expect(
			verifyJobsRequest('a-long-deployment-secret', null, body, null, now)
		).resolves.toBe(false);
	});
});
