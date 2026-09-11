import { afterAll, vi } from 'vitest';
import { disposeTestPlatform } from './platform';

// The route harness explicitly opts into fake WorkOS authentication.
vi.mock('$app/environment', () => ({
	dev: true,
	browser: false,
	building: false
}));

afterAll(async () => {
	await disposeTestPlatform();
});
