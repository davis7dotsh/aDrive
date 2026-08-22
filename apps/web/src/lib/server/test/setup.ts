import { afterAll } from 'vitest';
import { disposeTestPlatform } from './platform';

afterAll(async () => {
	await disposeTestPlatform();
});
