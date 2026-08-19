import { describe, expect, it } from 'vitest';
import { errorResult, jsonResult } from './result';

describe('MCP results', () => {
	it('serializes a value as JSON text content', () => {
		const result = jsonResult({ ok: true, id: 'file-1' });
		expect(result.content[0]?.text).toBe('{"ok":true,"id":"file-1"}');
		expect('isError' in result).toBe(false);
	});

	it('marks failures without leaking extra fields', () => {
		const result = errorResult('Not found', 404);
		expect(result.isError).toBe(true);
		expect(JSON.parse(result.content[0]?.text ?? '')).toEqual({
			ok: false,
			message: 'Not found',
			status: 404
		});
	});
});
