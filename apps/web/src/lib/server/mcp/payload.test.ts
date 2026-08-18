import { describe, expect, it } from 'vitest';
import { InvalidRequest } from '../errors';
import {
	MCP_MAX_BASE64_CHARS,
	MCP_MAX_UPLOAD_BYTES,
	decodeBase64,
	decodeExclusiveContent,
	mcpPageLimit
} from './payload';

describe('MCP payload', () => {
	it('requires exactly one of text or content_base64', () => {
		expect(decodeExclusiveContent({}).ok).toBe(false);
		expect(
			decodeExclusiveContent({ text: 'hi', content_base64: 'aGk=' }).ok
		).toBe(false);
		expect(decodeExclusiveContent({ text: 'hi' })).toEqual({
			ok: true,
			bytes: new TextEncoder().encode('hi')
		});
	});

	it('accepts empty text as a zero-byte file', () => {
		const decoded = decodeExclusiveContent({ text: '' });
		expect(decoded.ok).toBe(true);
		if (decoded.ok) expect(decoded.bytes.byteLength).toBe(0);
	});

	it('decodes standard and URL-safe base64', () => {
		expect([...decodeBase64('aGk=')]).toEqual([
			...new TextEncoder().encode('hi')
		]);
		expect([...decodeBase64('aGk')]).toEqual([
			...new TextEncoder().encode('hi')
		]);
		const urlSafe = btoa('\xff\xef').replaceAll('+', '-').replaceAll('/', '_');
		expect([...decodeBase64(urlSafe)]).toEqual([255, 239]);
	});

	it('rejects oversized payloads before decoding', () => {
		const decoded = decodeExclusiveContent({
			text: 'x'.repeat(MCP_MAX_UPLOAD_BYTES + 1)
		});
		expect(decoded).toEqual({
			ok: false,
			message: 'Content exceeds the 2 MiB MCP upload limit',
			status: 413
		});
		expect(
			decodeExclusiveContent({
				content_base64: 'A'.repeat(MCP_MAX_BASE64_CHARS + 1)
			})
		).toEqual({
			ok: false,
			message: 'Content exceeds the 2 MiB MCP upload limit',
			status: 413
		});
	});

	it('defaults list pages to 50 and caps at 200', () => {
		expect(mcpPageLimit(undefined)).toBe(50);
		expect(mcpPageLimit(1)).toBe(1);
		expect(mcpPageLimit(200)).toBe(200);
		expect(() => mcpPageLimit(0)).toThrow(InvalidRequest);
		expect(() => mcpPageLimit(201)).toThrow(InvalidRequest);
	});
});
