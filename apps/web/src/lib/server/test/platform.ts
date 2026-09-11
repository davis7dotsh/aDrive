import { getPlatformProxy } from 'wrangler';
import { TEST_DATABASE_URL } from './database';

// One proxy for the whole run: getPlatformProxy spawns a workerd instance
// and persists D1/R2/KV in isolated test state, so suites share the database
// globalSetup migrated without touching the normal local development state.
// Vitest runs these files with fileParallelism: false.
let proxyPromise: ReturnType<typeof getPlatformProxy> | undefined;

export const getTestPlatform = async () => {
	// Wrangler reads this before building the Hyperdrive binding, so the
	// proxy talks to the test database instead of the dev one.
	process.env.CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE =
		TEST_DATABASE_URL;
	proxyPromise ??= getPlatformProxy({
		configPath: 'wrangler.jsonc',
		persist: { path: '.wrangler/test-state/v3' }
	});
	return proxyPromise;
};

export const disposeTestPlatform = async () => {
	const proxy = await proxyPromise;
	await proxy?.dispose();
	proxyPromise = undefined;
};
