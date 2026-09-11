import { beforeEach, describe, expect, it, vi } from 'vitest';

const environment = vi.hoisted(() => ({ dev: false }));
vi.mock('$app/environment', () => ({
	get dev() {
		return environment.dev;
	}
}));

import { configFromEnv } from './config';

// Config reads these scalar bindings only; no platform services are needed.
const env = {
	DASHBOARD_ORIGIN: 'https://drive.example.com',
	CONTENT_DOMAIN: 'content.example.com',
	MAX_UPLOAD_BYTES: '99614720',
	MAINTENANCE_SECRET: 'config-test-maintenance-secret',
	SEMANTIC_SEARCH: 'auto',
	EMBEDDING_MODEL: '@cf/baai/bge-small-en-v1.5',
	EMBEDDING_POOLING: 'cls',
	EMBEDDING_DIMENSIONS: '384',
	WORKOS_API_KEY: 'sk_config_test',
	WORKOS_CLIENT_ID: 'client_config_test',
	WORKOS_COOKIE_PASSWORD: 'config-test-cookie-password-of-32-characters',
	WORKOS_WEBHOOK_SECRET: 'config-test-webhook-secret'
} as Env;

describe('WorkOS configuration', () => {
	beforeEach(() => {
		environment.dev = false;
	});

	it.each([undefined, '', '   ', 'fake:production'])(
		'rejects production API key %s even with fake opt-in',
		(apiKey) => {
			for (const fake of [undefined, 'true']) {
				expect(() =>
					configFromEnv({
						...env,
						WORKOS_API_KEY: apiKey,
						WORKOS_DEV_FAKE: fake
					})
				).toThrow('WORKOS_API_KEY is required');
			}
		}
	);

	it.each([undefined, '', 'fake:development'])(
		'requires explicit development opt-in for API key %s',
		(apiKey) => {
			const candidate = { ...env, WORKOS_API_KEY: apiKey };
			environment.dev = true;
			expect(() => configFromEnv(candidate)).toThrow('WORKOS_DEV_FAKE=true');
			expect(() =>
				configFromEnv({ ...candidate, WORKOS_DEV_FAKE: 'false' })
			).toThrow('WORKOS_DEV_FAKE=true');
			expect(
				configFromEnv({ ...candidate, WORKOS_DEV_FAKE: 'true' }).workos.apiKey
			).toBeNull();
		}
	);

	it('uses real credentials even when the development flag is set', () => {
		for (const dev of [false, true]) {
			environment.dev = dev;
			expect(configFromEnv({ ...env, WORKOS_DEV_FAKE: 'true' }).workos).toEqual(
				{
					apiKey: env.WORKOS_API_KEY,
					clientId: env.WORKOS_CLIENT_ID,
					cookiePassword: env.WORKOS_COOKIE_PASSWORD,
					webhookSecret: env.WORKOS_WEBHOOK_SECRET
				}
			);
		}
	});

	it.each([
		{ binding: 'WORKOS_CLIENT_ID', value: '' },
		{ binding: 'WORKOS_COOKIE_PASSWORD', value: 'too-short' },
		{ binding: 'WORKOS_WEBHOOK_SECRET', value: '' }
	])(
		'still validates $binding for live authentication',
		({ binding, value }) => {
			expect(() => configFromEnv({ ...env, [binding]: value })).toThrow(
				binding
			);
		}
	);
});
