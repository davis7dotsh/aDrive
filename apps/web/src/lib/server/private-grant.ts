const textEncoder = new TextEncoder();
const SIGNATURE_PATTERN = /^[A-Za-z0-9_-]{43}$/;

export const PRIVATE_GRANT_TTL_SECONDS = 15 * 60;

interface PrivateGrantScope {
	readonly contentOrigin: string;
	readonly fileId: string;
	readonly version: number;
	readonly expiresAtSeconds: number;
}

interface MintPrivateGrantOptions extends Omit<
	PrivateGrantScope,
	'expiresAtSeconds'
> {
	readonly secret: string;
	readonly now?: Date;
}

interface VerifyPrivateGrantOptions extends PrivateGrantScope {
	readonly secret: string;
	readonly requestOrigin: string;
	readonly signature: string;
	readonly now?: Date;
}

const grantPayload = ({
	contentOrigin,
	fileId,
	version,
	expiresAtSeconds
}: PrivateGrantScope) =>
	[
		'adrive-private-file-grant-v1',
		contentOrigin,
		fileId,
		String(version),
		String(expiresAtSeconds)
	].join('\n');

const signingKey = (secret: string) =>
	crypto.subtle.importKey(
		'raw',
		textEncoder.encode(secret),
		{ name: 'HMAC', hash: 'SHA-256' },
		false,
		['sign', 'verify']
	);

const base64Url = (value: ArrayBuffer) => {
	const bytes = new Uint8Array(value);
	let binary = '';
	for (const byte of bytes) binary += String.fromCharCode(byte);
	return btoa(binary)
		.replaceAll('+', '-')
		.replaceAll('/', '_')
		.replace(/=+$/u, '');
};

const decodeBase64Url = (value: string) => {
	if (!SIGNATURE_PATTERN.test(value)) return;
	const binary = atob(value.replaceAll('-', '+').replaceAll('_', '/') + '=');
	const bytes = new Uint8Array(binary.length);
	for (let index = 0; index < binary.length; index += 1) {
		bytes[index] = binary.charCodeAt(index);
	}
	return bytes;
};

const validScope = ({ fileId, version, expiresAtSeconds }: PrivateGrantScope) =>
	fileId.length > 0 &&
	Number.isSafeInteger(version) &&
	version > 0 &&
	Number.isSafeInteger(expiresAtSeconds) &&
	expiresAtSeconds > 0;

export const mintPrivateGrant = async ({
	secret,
	contentOrigin,
	fileId,
	version,
	now = new Date()
}: MintPrivateGrantOptions) => {
	const expiresAtSeconds =
		Math.floor(now.getTime() / 1_000) + PRIVATE_GRANT_TTL_SECONDS;
	const scope = { contentOrigin, fileId, version, expiresAtSeconds };
	const key = await signingKey(secret);
	const signature = base64Url(
		await crypto.subtle.sign(
			'HMAC',
			key,
			textEncoder.encode(grantPayload(scope))
		)
	);
	return { expiresAtSeconds, signature };
};

export const verifyPrivateGrant = async ({
	secret,
	requestOrigin,
	signature,
	now = new Date(),
	...scope
}: VerifyPrivateGrantOptions) => {
	if (
		requestOrigin !== scope.contentOrigin ||
		!validScope(scope) ||
		scope.expiresAtSeconds < Math.floor(now.getTime() / 1_000) ||
		scope.expiresAtSeconds >
			Math.floor(now.getTime() / 1_000) + PRIVATE_GRANT_TTL_SECONDS
	) {
		return false;
	}
	const decoded = decodeBase64Url(signature);
	if (!decoded) return false;
	const key = await signingKey(secret);
	return crypto.subtle.verify(
		'HMAC',
		key,
		decoded,
		textEncoder.encode(grantPayload(scope))
	);
};
