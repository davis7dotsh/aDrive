import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import {
	mkdtempSync,
	mkdirSync,
	readFileSync,
	rmSync,
	writeFileSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sameJson, stripComments } from './check-wrangler-drift.mjs';

describe('check-wrangler-drift helpers', () => {
	it('keeps // inside JSON strings', () => {
		const parsed = JSON.parse(
			stripComments('{ "NOTE": "see docs // then more" }')
		);
		expect(parsed.NOTE).toBe('see docs // then more');
	});

	it('treats equivalent objects with different key order as equal', () => {
		expect(
			sameJson(
				{ enabled: true, traces: { enabled: true, head_sampling_rate: 0.01 } },
				{ traces: { head_sampling_rate: 0.01, enabled: true }, enabled: true }
			)
		).toBe(true);
	});
});

describe('deployment ids and source config checks', () => {
	const script = fileURLToPath(
		new URL('./check-wrangler-drift.mjs', import.meta.url)
	);
	const original = JSON.parse(
		stripComments(
			readFileSync(
				new URL('../apps/web/wrangler.jsonc', import.meta.url),
				'utf8'
			)
		)
	);
	const check = (flags, mutate = () => {}) => {
		const root = mkdtempSync(join(tmpdir(), 'adrive-config-check-'));
		try {
			const config = structuredClone(original);
			config.env.production.hyperdrive[0].id = 'replace-with-test-hyperdrive';
			mutate(config);
			mkdirSync(join(root, 'apps/web'), { recursive: true });
			writeFileSync(
				join(root, 'apps/web/wrangler.jsonc'),
				JSON.stringify(config)
			);
			return spawnSync(process.execPath, [script, ...flags], {
				cwd: root,
				encoding: 'utf8'
			});
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	};

	it('allows unprovisioned ids for source checks while enforcing binding parity', () => {
		expect(check(['--allow-placeholders']).status).toBe(0);
		const drift = check(['--allow-placeholders'], (config) => {
			config.env.production.hyperdrive = [];
		});
		expect(drift.status).toBe(1);
		expect(drift.stderr).toContain('hyperdrive bindings');
	});

	it('refuses placeholder ids for deployment even with the source-only flag', () => {
		for (const flags of [
			[],
			['--placeholders-only'],
			['--placeholders-only', '--allow-placeholders']
		]) {
			const result = check(flags);
			expect(result.status).toBe(1);
			expect(result.stderr).toContain(
				'Hyperdrive HYPERDRIVE: still has a placeholder id'
			);
		}
	});
});
