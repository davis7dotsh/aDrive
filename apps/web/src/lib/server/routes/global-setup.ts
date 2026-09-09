import { execSync } from 'node:child_process';
import { rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { migrate } from '../../../../scripts/pg-migrate.mjs';
import { TEST_DATABASE_URL } from '../test/database';

// Reset isolated test state and apply migrations so every run starts from
// a known-empty database without touching the normal local dev state.
// D1 state lives under .wrangler/test-state; Postgres uses the adrive_test
// database on the local docker compose instance and is dropped and
// recreated here.
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
	await migrate({ url: TEST_DATABASE_URL, reset: true, log: () => {} });
}
