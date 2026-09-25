// Ephemeral UI identifiers. getRandomValues also works in HTTP development
// contexts, where the secure-context-only randomUUID API is unavailable.
export const createClientId = () =>
	Array.from(crypto.getRandomValues(new Uint8Array(16)), (byte) =>
		byte.toString(16).padStart(2, '0')
	).join('');
