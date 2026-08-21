import { getPlatformProxy } from 'wrangler';

// One proxy for the whole run: getPlatformProxy spawns a workerd instance
// and the local D1/R2/KV state persists in .wrangler/state, so suites share
// the database the globalSetup migrated. Vitest runs these files with
// fileParallelism: false (see vitest.routes.config.ts).
let proxyPromise: ReturnType<typeof getPlatformProxy> | undefined;

export const getTestPlatform = async () => {
	proxyPromise ??= getPlatformProxy({ configPath: 'wrangler.jsonc' });
	return proxyPromise;
};

export const disposeTestPlatform = async () => {
	const proxy = await proxyPromise;
	await proxy?.dispose();
	proxyPromise = undefined;
};
