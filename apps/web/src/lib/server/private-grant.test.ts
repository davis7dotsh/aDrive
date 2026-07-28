import { describe, expect, it } from 'vitest';
import {
	mintPrivateGrant,
	PRIVATE_GRANT_TTL_SECONDS,
	verifyPrivateGrant
} from './private-grant';

const secret = 'a deployment-only passcode';
const contentOrigin = 'https://content.example.test';
const now = new Date('2026-07-27T12:00:00.000Z');

const mint = () =>
	mintPrivateGrant({
		secret,
		contentOrigin,
		fileId: 'file-1',
		version: 4,
		now
	});

describe('private file grants', () => {
	it('validates repeatedly on the content origin during its short lifetime', async () => {
		const grant = await mint();
		const verify = (at: Date) =>
			verifyPrivateGrant({
				secret,
				contentOrigin,
				requestOrigin: contentOrigin,
				fileId: 'file-1',
				version: 4,
				expiresAtSeconds: grant.expiresAtSeconds,
				signature: grant.signature,
				now: at
			});

		await expect(verify(now)).resolves.toBe(true);
		await expect(verify(new Date(now.getTime() + 10 * 60_000))).resolves.toBe(
			true
		);
		expect(grant.expiresAtSeconds).toBe(
			Math.floor(now.getTime() / 1_000) + PRIVATE_GRANT_TTL_SECONDS
		);
	});

	it('binds grants to the configured host, file, and resolved version', async () => {
		const grant = await mint();
		const base = {
			secret,
			contentOrigin,
			requestOrigin: contentOrigin,
			fileId: 'file-1',
			version: 4,
			expiresAtSeconds: grant.expiresAtSeconds,
			signature: grant.signature,
			now
		};

		await expect(
			verifyPrivateGrant({
				...base,
				requestOrigin: 'https://dashboard.example.test'
			})
		).resolves.toBe(false);
		await expect(
			verifyPrivateGrant({ ...base, fileId: 'file-2' })
		).resolves.toBe(false);
		await expect(verifyPrivateGrant({ ...base, version: 5 })).resolves.toBe(
			false
		);
	});

	it('rejects expired and tampered grants', async () => {
		const grant = await mint();
		const base = {
			secret,
			contentOrigin,
			requestOrigin: contentOrigin,
			fileId: 'file-1',
			version: 4,
			expiresAtSeconds: grant.expiresAtSeconds,
			signature: grant.signature
		};

		await expect(
			verifyPrivateGrant({
				...base,
				now: new Date(now.getTime() + (PRIVATE_GRANT_TTL_SECONDS + 1) * 1_000)
			})
		).resolves.toBe(false);
		await expect(
			verifyPrivateGrant({
				...base,
				expiresAtSeconds:
					Math.floor(now.getTime() / 1_000) + PRIVATE_GRANT_TTL_SECONDS + 1,
				now
			})
		).resolves.toBe(false);
		await expect(
			verifyPrivateGrant({
				...base,
				signature: `${grant.signature.slice(0, -1)}x`,
				now
			})
		).resolves.toBe(false);
	});
});
