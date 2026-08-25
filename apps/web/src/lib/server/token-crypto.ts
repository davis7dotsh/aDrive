// Small shared crypto helpers for opaque secret tokens (share links, and
// available to other stored-secret features). Mirrors the inline helpers in
// services/auth.ts: a URL-safe random secret with a short lookup prefix, plus
// SHA-256 hashing and a constant-time hex compare.

export const randomToken = (bytes = 32) => {
	const value = new Uint8Array(bytes);
	crypto.getRandomValues(value);
	return btoa(String.fromCharCode(...value))
		.replaceAll('+', '-')
		.replaceAll('/', '_')
		.replaceAll('=', '');
};

export const randomHex = (bytes: number) => {
	const value = new Uint8Array(bytes);
	crypto.getRandomValues(value);
	return Array.from(value, (byte) => byte.toString(16).padStart(2, '0')).join(
		''
	);
};

const toHex = (buffer: ArrayBuffer) =>
	Array.from(new Uint8Array(buffer), (byte) =>
		byte.toString(16).padStart(2, '0')
	).join('');

export const sha256Hex = (value: string) =>
	crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)).then(toHex);

const hexBytes = (value: string) => {
	const normalized = /^[0-9a-f]{64}$/i.test(value) ? value : '0'.repeat(64);
	return Uint8Array.from({ length: 32 }, (_, index) =>
		Number.parseInt(normalized.slice(index * 2, index * 2 + 2), 16)
	);
};

export const constantTimeEqualHex = (left: string, right: string) => {
	const a = hexBytes(left);
	const b = hexBytes(right);
	let difference = a.length ^ b.length;
	for (let index = 0; index < a.length; index += 1) {
		difference |= a[index]! ^ (b[index] ?? 0);
	}
	return difference === 0;
};
