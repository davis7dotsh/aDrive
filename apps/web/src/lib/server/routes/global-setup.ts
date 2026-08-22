import { execSync } from 'node:child_process';
import { rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Reset isolated test state and apply D1 migrations so every run starts
// from a known-empty database without touching the normal local dev state.
export default async function globalSetup() {
	const webRoot = join(
		dirname(fileURLToPath(import.meta.url)),
		'..',
		'..',
		'..',
		'..'
	);
	rmSync(join(webRoot, '.wrangler', 'test-state'), {
		recursive: true,
		force: true
	});
	execSync(
		'bunx wrangler d1 migrations apply DB --local --persist-to .wrangler/test-state',
		{
			cwd: webRoot,
			stdio: 'inherit'
		}
	);
}
