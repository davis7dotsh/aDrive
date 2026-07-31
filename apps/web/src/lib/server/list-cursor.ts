import { Schema } from 'effect';
import { InvalidRequest } from './errors';

const CursorState = Schema.Struct({
	k: Schema.String,
	id: Schema.String
});

export type ListCursor = typeof CursorState.Type;

const encoder = new TextEncoder();
const decoder = new TextDecoder();

const toBase64Url = (bytes: Uint8Array) =>
	btoa(String.fromCharCode(...bytes))
		.replaceAll('+', '-')
		.replaceAll('/', '_')
		.replaceAll('=', '');

const fromBase64Url = (value: string) => {
	const padded = value
		.replaceAll('-', '+')
		.replaceAll('_', '/')
		.padEnd(Math.ceil(value.length / 4) * 4, '=');
	return Uint8Array.from(atob(padded), (character) => character.charCodeAt(0));
};

export const encodeListCursor = (cursor: ListCursor) =>
	toBase64Url(encoder.encode(JSON.stringify(cursor)));

export const decodeListCursor = (value: string | null): ListCursor | null => {
	if (value === null || value === '') return null;
	if (value.length > 512) {
		throw new InvalidRequest({ status: 400, message: 'Cursor is invalid' });
	}
	try {
		const parsed: unknown = JSON.parse(decoder.decode(fromBase64Url(value)));
		const decoded = Schema.decodeUnknownOption(CursorState)(parsed);
		if (decoded._tag === 'None') throw new Error('shape');
		return decoded.value;
	} catch {
		throw new InvalidRequest({ status: 400, message: 'Cursor is invalid' });
	}
};

export const parsePageSize = (
	value: string | null,
	fallback: number,
	max: number
) => {
	if (value === null || value === '') return fallback;
	const parsed = Number(value);
	if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > max) {
		throw new InvalidRequest({
			status: 400,
			message: `Page size must be between 1 and ${max}`
		});
	}
	return parsed;
};
