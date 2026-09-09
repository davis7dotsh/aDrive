import { rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { migrate } from '../../../../scripts/pg-migrate.mjs';
import { TEST_DATABASE_URL } from '../test/database';

// Reset isolated test state so every run starts from a known-empty
// database without touching the normal local dev state. R2 and KV state
// live under .wrangler/test-state; Postgres uses the test database on the
// local docker compose instance and is dropped and recreated here.
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
	await migrate({ url: TEST_DATABASE_URL, reset: true, log: () => {} });
}
