import { execSync } from 'node:child_process';
import { rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Reset local platform state and apply D1 migrations so every run starts
// from a known-empty database. State lives in .wrangler/state (gitignored,
// disposable local dev data).
export default async function globalSetup() {
	const webRoot = join(
		dirname(fileURLToPath(import.meta.url)),
		'..',
		'..',
		'..',
		'..'
	);
	rmSync(join(webRoot, '.wrangler', 'state'), { recursive: true, force: true });
	execSync('bunx wrangler d1 migrations apply DB --local', {
		cwd: webRoot,
		stdio: 'inherit'
	});
}
