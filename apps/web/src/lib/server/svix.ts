// Svix webhook signatures (Autumn delivers through Svix), verified with
// WebCrypto so no library is needed. The signed content is
// `<svix-id>.<svix-timestamp>.<body>`, the secret is `whsec_<base64>`,
// and the signature header carries one or more space-separated
// `v1,<base64>` entries (several during a secret rotation).

export const SVIX_TOLERANCE_SECONDS = 5 * 60;

export interface SvixHeaders {
	readonly id: string | null;
	readonly timestamp: string | null;
	readonly signature: string | null;
}

export type SvixVerification =
	| { readonly ok: true }
	| {
			readonly ok: false;
			readonly reason:
				'missing-headers' | 'stale-timestamp' | 'bad-signature' | 'bad-secret';
	  };

const encoder = new TextEncoder();

type Bytes = Uint8Array<ArrayBuffer>;

const decodeBase64 = (value: string): Bytes | null => {
	try {
		return Uint8Array.from(atob(value), (char) => char.charCodeAt(0));
	} catch {
		return null;
	}
};

const encodeBase64 = (bytes: ArrayBuffer) =>
	btoa(String.fromCharCode(...new Uint8Array(bytes)));

const secretBytes = (secret: string) =>
	decodeBase64(secret.startsWith('whsec_') ? secret.slice(6) : secret);

const constantTimeEqual = (left: Bytes, right: Bytes) => {
	let difference = left.length ^ right.length;
	for (let index = 0; index < left.length; index += 1) {
		difference |= left[index]! ^ (right[index] ?? 0);
	}
	return difference === 0;
};

const hmac = async (key: Bytes, content: string): Promise<Bytes> => {
	const cryptoKey = await crypto.subtle.importKey(
		'raw',
		key,
		{ name: 'HMAC', hash: 'SHA-256' },
		false,
		['sign']
	);
	return new Uint8Array(
		await crypto.subtle.sign('HMAC', cryptoKey, encoder.encode(content))
	);
};

// The signature Svix would send for this message; tests use it to build
// deliveries and it doubles as the reference for verification.
export const signSvix = async (
	secret: string,
	id: string,
	timestamp: string,
	body: string
) => {
	const key = secretBytes(secret);
	if (key === null || key.length === 0) return null;
	const signature = await hmac(key, `${id}.${timestamp}.${body}`);
	return `v1,${encodeBase64(signature.buffer)}`;
};

export const verifySvix = async (
	secret: string,
	headers: SvixHeaders,
	body: string,
	nowSeconds = Math.floor(Date.now() / 1000)
): Promise<SvixVerification> => {
	const key = secretBytes(secret);
	if (key === null || key.length === 0) {
		return { ok: false, reason: 'bad-secret' };
	}
	if (!headers.id || !headers.timestamp || !headers.signature) {
		return { ok: false, reason: 'missing-headers' };
	}
	const sent = Number(headers.timestamp);
	if (
		!Number.isFinite(sent) ||
		Math.abs(nowSeconds - sent) > SVIX_TOLERANCE_SECONDS
	) {
		return { ok: false, reason: 'stale-timestamp' };
	}
	const expected = await hmac(
		key,
		`${headers.id}.${headers.timestamp}.${body}`
	);
	const presented = headers.signature
		.split(' ')
		.map((entry) => entry.trim())
		.filter((entry) => entry.startsWith('v1,'))
		.map((entry) => decodeBase64(entry.slice(3)))
		.filter((bytes): bytes is Bytes => bytes !== null);
	// Every candidate is compared so the timing does not reveal which one
	// (if any) matched.
	let matched = false;
	for (const candidate of presented) {
		if (constantTimeEqual(expected, candidate)) matched = true;
	}
	return matched ? { ok: true } : { ok: false, reason: 'bad-signature' };
};
