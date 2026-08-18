import { InvalidRequest } from '../errors';

export const MCP_MAX_UPLOAD_BYTES = 2 * 1024 * 1024;
export const MCP_MAX_SITE_TOTAL_BYTES = 8 * 1024 * 1024;
export const MCP_LIST_DEFAULT = 50;
export const MCP_LIST_MAX = 200;
export const MCP_STATUS_PAGE_SIZE = 200;
export const MCP_STATUS_PAGE_CAP = 500;

export type DecodedContent =
	| { readonly ok: true; readonly bytes: Uint8Array }
	| {
			readonly ok: false;
			readonly message: string;
			readonly status: 400 | 413;
	  };

const padBase64 = (value: string) => {
	const rem = value.length % 4;
	return rem === 0 ? value : `${value}${'='.repeat(4 - rem)}`;
};

export const decodeBase64 = (value: string) => {
	const compact = value.replace(/\s+/g, '');
	if (compact.length === 0) return new Uint8Array();
	const normalized = padBase64(
		compact.replaceAll('-', '+').replaceAll('_', '/')
	);
	try {
		const binary = atob(normalized);
		const bytes = new Uint8Array(binary.length);
		for (let i = 0; i < binary.length; i++) {
			bytes[i] = binary.charCodeAt(i);
		}
		return bytes;
	} catch {
		throw new InvalidRequest({
			status: 400,
			message: 'content_base64 is invalid'
		});
	}
};

const bytesFromInput = (input: {
	readonly text?: string;
	readonly content_base64?: string;
}): DecodedContent => {
	if (input.text !== undefined) {
		return { ok: true, bytes: new TextEncoder().encode(input.text) };
	}
	try {
		return { ok: true, bytes: decodeBase64(input.content_base64 ?? '') };
	} catch (cause) {
		const message =
			cause instanceof InvalidRequest
				? cause.message
				: 'content_base64 is invalid';
		return { ok: false, message, status: 400 };
	}
};

export const decodeExclusiveContent = (input: {
	readonly text?: string;
	readonly content_base64?: string;
}): DecodedContent => {
	if ((input.text !== undefined) === (input.content_base64 !== undefined)) {
		return {
			ok: false,
			message: 'Provide exactly one of text or content_base64',
			status: 400
		};
	}
	const decoded = bytesFromInput(input);
	if (!decoded.ok) return decoded;
	if (decoded.bytes.byteLength > MCP_MAX_UPLOAD_BYTES) {
		return {
			ok: false,
			message: 'Content exceeds the 2 MiB MCP upload limit',
			status: 413
		};
	}
	return decoded;
};

export const bytesToStream = (bytes: Uint8Array) =>
	new ReadableStream<Uint8Array>({
		start(controller) {
			controller.enqueue(bytes);
			controller.close();
		}
	});

export const mcpPageLimit = (value: number | undefined) => {
	if (value === undefined) return MCP_LIST_DEFAULT;
	if (!Number.isSafeInteger(value) || value < 1 || value > MCP_LIST_MAX) {
		throw new InvalidRequest({
			status: 400,
			message: `Page size must be between 1 and ${MCP_LIST_MAX}`
		});
	}
	return value;
};
