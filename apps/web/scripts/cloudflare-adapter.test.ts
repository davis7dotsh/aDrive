import { describe, expect, it } from 'vitest';
import { facadeSource } from './cloudflare-adapter.mjs';

describe('Cloudflare Worker facade', () => {
	it('delegates fetch and exports a signed scheduled handler', () => {
		const source = facadeSource('_sveltekit.js');
		expect(source).toContain('return sveltekit.fetch(request, env, ctx)');
		expect(source).toContain('scheduled(controller, env, ctx)');
		expect(source).toContain("name: 'HMAC', hash: 'SHA-256'");
		expect(source).toContain('ctx.waitUntil(');
		expect(source).not.toContain('const { waitUntil } = ctx');
		expect(source).not.toContain('PASSCODE:');
		const executable = source
			.replace(
				'import sveltekit from "./_sveltekit.js";',
				'const sveltekit = {};'
			)
			.replace('export * from "./_sveltekit.js";', '')
			.replace('export default', 'return');
		expect(() => new Function(executable)).not.toThrow();
	});
});
