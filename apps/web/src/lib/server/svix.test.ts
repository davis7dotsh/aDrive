import { describe, expect, it } from 'vitest';
import { signSvix, verifySvix } from './svix';

// `whsec_` + base64("a-test-signing-secret")
const SECRET = 'whsec_YS10ZXN0LXNpZ25pbmctc2VjcmV0';
const BODY = '{"type":"billing.updated","data":{"customer_id":"org_1"}}';
const NOW = 1_800_000_000;

const headersFor = async (
	overrides: Partial<{ id: string; timestamp: string; signature: string }> = {}
) => {
	const id = overrides.id ?? 'msg_1';
	const timestamp = overrides.timestamp ?? String(NOW);
	const signature =
		overrides.signature ?? (await signSvix(SECRET, id, timestamp, BODY)) ?? '';
	return { id, timestamp, signature };
};

describe('Svix signature verification', () => {
	it('accepts a signature made with the secret', async () => {
		expect(await verifySvix(SECRET, await headersFor(), BODY, NOW)).toEqual({
			ok: true
		});
	});

	it('accepts the bare base64 secret and any matching entry of several', async () => {
		const bare = SECRET.slice('whsec_'.length);
		const { id, timestamp, signature } = await headersFor();
		expect(
			await verifySvix(
				bare,
				{ id, timestamp, signature: `v1,bm90LXRoaXMtb25l ${signature}` },
				BODY,
				NOW
			)
		).toEqual({ ok: true });
	});

	it('rejects a tampered body, id, or signature', async () => {
		const headers = await headersFor();
		expect(await verifySvix(SECRET, headers, `${BODY} `, NOW)).toEqual({
			ok: false,
			reason: 'bad-signature'
		});
		expect(
			await verifySvix(SECRET, { ...headers, id: 'msg_2' }, BODY, NOW)
		).toEqual({ ok: false, reason: 'bad-signature' });
		expect(
			await verifySvix(
				SECRET,
				{ ...headers, signature: 'v1,bm90LXRoaXMtb25l' },
				BODY,
				NOW
			)
		).toEqual({ ok: false, reason: 'bad-signature' });
		expect(
			await verifySvix('whsec_YW5vdGhlci1zZWNyZXQ=', headers, BODY, NOW)
		).toEqual({ ok: false, reason: 'bad-signature' });
	});

	it('rejects a delivery outside the timestamp tolerance', async () => {
		const headers = await headersFor({ timestamp: String(NOW - 6 * 60) });
		expect(await verifySvix(SECRET, headers, BODY, NOW)).toEqual({
			ok: false,
			reason: 'stale-timestamp'
		});
		expect(
			await verifySvix(
				SECRET,
				{ ...headers, timestamp: 'yesterday' },
				BODY,
				NOW
			)
		).toEqual({ ok: false, reason: 'stale-timestamp' });
	});

	it('rejects missing headers and an unusable secret', async () => {
		const headers = await headersFor();
		expect(
			await verifySvix(SECRET, { ...headers, signature: null }, BODY, NOW)
		).toEqual({ ok: false, reason: 'missing-headers' });
		expect(await verifySvix('', headers, BODY, NOW)).toEqual({
			ok: false,
			reason: 'bad-secret'
		});
		expect(await signSvix('', 'id', '1', BODY)).toBeNull();
	});
});
