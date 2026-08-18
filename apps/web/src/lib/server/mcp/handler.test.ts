import { describe, expect, it } from 'vitest';
import { mcpAllowedHostnames } from './handler';
import { READ_TOOL_NAMES, WRITE_TOOL_NAMES } from './server';

describe('MCP handler policy', () => {
	it('allows the dashboard host plus loopback', () => {
		expect(mcpAllowedHostnames('https://drive.example.com')).toEqual([
			'drive.example.com',
			'localhost',
			'127.0.0.1'
		]);
		expect(mcpAllowedHostnames('http://localhost:5173')).toEqual([
			'localhost',
			'127.0.0.1'
		]);
	});

	it('keeps write tools off the read-only list', () => {
		for (const name of WRITE_TOOL_NAMES) {
			expect((READ_TOOL_NAMES as readonly string[]).includes(name)).toBe(false);
		}
		expect(READ_TOOL_NAMES).toContain('search_files');
		expect(WRITE_TOOL_NAMES).toContain('publish_site');
	});
});
