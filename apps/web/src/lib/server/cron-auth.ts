const SIGNATURE_WINDOW_MS = 5 * 60 * 1_000;

const bytesToHex = (bytes: ArrayBuffer) =>
	Array.from(new Uint8Array(bytes), (byte) =>
		byte.toString(16).padStart(2, '0')
	).join('');

const hexToBytes = (value: string) =>
	/^[a-f0-9]{64}$/i.test(value)
		? Uint8Array.from({ length: 32 }, (_, index) =>
				Number.parseInt(value.slice(index * 2, index * 2 + 2), 16)
			)
		: new Uint8Array(32);

const hmacKey = (passcode: string, usage: KeyUsage) =>
	crypto.subtle.importKey(
		'raw',
		new TextEncoder().encode(passcode),
		{ name: 'HMAC', hash: 'SHA-256' },
		false,
		[usage]
	);

const scheduledMessage = (scheduledTime: string, cron: string) =>
	new TextEncoder().encode(`${scheduledTime}\n${cron}`);

export const signScheduledRequest = async (
	passcode: string,
	scheduledTime: string,
	cron: string
) => {
	const key = await hmacKey(passcode, 'sign');
	return bytesToHex(
		await crypto.subtle.sign('HMAC', key, scheduledMessage(scheduledTime, cron))
	);
};

export const verifyScheduledRequest = async (
	passcode: string,
	scheduledTime: string | null,
	cron: string | null,
	signature: string | null,
	now = Date.now()
) => {
	if (!scheduledTime || !cron || !signature) return false;
	const timestamp = Number(scheduledTime);
	if (
		!Number.isSafeInteger(timestamp) ||
		Math.abs(now - timestamp) > SIGNATURE_WINDOW_MS
	) {
		return false;
	}
	const key = await hmacKey(passcode, 'verify');
	return crypto.subtle.verify(
		'HMAC',
		key,
		hexToBytes(signature),
		scheduledMessage(scheduledTime, cron)
	);
};
