import { Effect, Layer } from 'effect';
import { describe, expect, it } from 'vitest';
import { authRateLimitResponse } from '../auth-rate-limit-response';
import { StorageError } from '../errors';
import { AuthGuard, AuthGuardLive, type AuthGuardShape } from './auth-guard';
import { AuthGuardStore, type AuthGuardStoreShape } from './bindings';

class MemoryAuthGuardStore implements AuthGuardStoreShape {
	readonly values = new Map<string, string>();
	readonly ttls = new Map<string, number>();

	async get(key: string) {
		return this.values.get(key) ?? null;
	}

	async put(
		key: string,
		value: string,
		options: { readonly expirationTtl: number }
	) {
		this.values.set(key, value);
		this.ttls.set(key, options.expirationTtl);
	}

	async delete(key: string) {
		this.values.delete(key);
		this.ttls.delete(key);
	}
}

const setup = () => {
	const store = new MemoryAuthGuardStore();
	let nowMs = Date.parse('2026-07-30T12:00:00.000Z');
	const bindings = Layer.succeed(AuthGuardStore, store);
	const layer = AuthGuardLive(() => new Date(nowMs)).pipe(
		Layer.provide(bindings)
	);
	const run = <A, E>(program: Effect.Effect<A, E, AuthGuard>) =>
		Effect.runPromise(program.pipe(Effect.provide(layer)));
	const guard = <A, E>(use: (service: AuthGuardShape) => Effect.Effect<A, E>) =>
		run(
			Effect.gen(function* () {
				return yield* use(yield* AuthGuard);
			})
		);
	return {
		store,
		guard,
		advance: (milliseconds: number) => {
			nowMs += milliseconds;
		}
	};
};

describe('KV auth guard', () => {
	it('limits passcode login attempts within a fixed window', async () => {
		const { guard } = setup();
		for (let attempt = 1; attempt <= 10; attempt += 1) {
			await expect(
				guard((service) => service.consume('passcodeLogin', '203.0.113.8'))
			).resolves.toMatchObject({
				allowed: true,
				remaining: 10 - attempt
			});
		}

		await expect(
			guard((service) => service.consume('passcodeLogin', '203.0.113.8'))
		).resolves.toMatchObject({
			allowed: false,
			reason: 'rate-limit',
			retryAfterSeconds: 300
		});
	});

	it('resets counters after the policy window and isolates clients', async () => {
		const { guard, advance } = setup();
		for (let attempt = 0; attempt < 5; attempt += 1) {
			await guard((service) => service.consume('deviceCreate', '198.51.100.1'));
		}
		await expect(
			guard((service) => service.consume('deviceCreate', '198.51.100.1'))
		).resolves.toMatchObject({ allowed: false });
		await expect(
			guard((service) => service.consume('deviceCreate', '198.51.100.2'))
		).resolves.toMatchObject({ allowed: true, remaining: 4 });

		advance(10 * 60 * 1_000);
		await expect(
			guard((service) => service.consume('deviceCreate', '198.51.100.1'))
		).resolves.toMatchObject({ allowed: true, remaining: 4 });
	});

	it('locks a client after five bad passcodes and clears failures on success', async () => {
		const { guard } = setup();
		for (let failure = 1; failure < 5; failure += 1) {
			await expect(
				guard((service) => service.recordPasscodeFailure('192.0.2.40'))
			).resolves.toMatchObject({
				allowed: true,
				remaining: 5 - failure
			});
		}

		await expect(
			guard((service) => service.recordPasscodeFailure('192.0.2.40'))
		).resolves.toMatchObject({
			allowed: false,
			reason: 'lockout',
			retryAfterSeconds: 30 * 60
		});
		await expect(
			guard((service) => service.checkPasscodeLock('192.0.2.40'))
		).resolves.toMatchObject({ allowed: false, reason: 'lockout' });

		await guard((service) => service.clearPasscodeFailures('192.0.2.40'));
		await expect(
			guard((service) => service.checkPasscodeLock('192.0.2.40'))
		).resolves.toMatchObject({ allowed: true });
	});

	it('starts a fresh failure window after fifteen minutes', async () => {
		const { guard, advance } = setup();
		await guard((service) => service.recordPasscodeFailure('192.0.2.50'));
		advance(15 * 60 * 1_000);
		await expect(
			guard((service) => service.recordPasscodeFailure('192.0.2.50'))
		).resolves.toMatchObject({ allowed: true, remaining: 4 });
	});

	it('hashes client identifiers before storing KV keys', async () => {
		const { guard, store } = setup();
		await guard((service) => service.consume('devicePoll', '2001:db8::1234'));
		const keys = Array.from(store.values.keys());
		expect(keys).toHaveLength(1);
		expect(keys[0]).toMatch(/^v1:device-poll:[a-f0-9]{64}$/);
		expect(keys[0]).not.toContain('2001:db8::1234');
		expect(Array.from(store.ttls.values())[0]).toBeGreaterThanOrEqual(60);
	});

	it('fails closed when KV operations fail', async () => {
		const brokenStore: AuthGuardStoreShape = {
			get: async () => {
				throw new Error('KV unavailable');
			},
			put: async () => {},
			delete: async () => {}
		};
		const layer = AuthGuardLive().pipe(
			Layer.provide(Layer.succeed(AuthGuardStore, brokenStore))
		);
		const program = Effect.gen(function* () {
			const service = yield* AuthGuard;
			return yield* service.consume('passcodeLogin', '203.0.113.9');
		}).pipe(Effect.provide(layer));

		await expect(Effect.runPromise(program)).rejects.toBeInstanceOf(
			StorageError
		);
	});

	it('turns a contended KV write into a temporary rate limit', async () => {
		const contendedStore: AuthGuardStoreShape = {
			get: async () => null,
			put: async () => {
				throw new Error('429: one write per second');
			},
			delete: async () => {}
		};
		const layer = AuthGuardLive().pipe(
			Layer.provide(Layer.succeed(AuthGuardStore, contendedStore))
		);
		const program = Effect.gen(function* () {
			const service = yield* AuthGuard;
			return yield* service.consume('passcodeLogin', '203.0.113.10');
		}).pipe(Effect.provide(layer));

		await expect(Effect.runPromise(program)).resolves.toMatchObject({
			allowed: false,
			reason: 'rate-limit',
			retryAfterSeconds: 60
		});
	});

	it('returns a private 429 response with retry guidance', async () => {
		const response = authRateLimitResponse({
			allowed: false,
			reason: 'lockout',
			retryAfterSeconds: 90,
			resetAtMs: Date.now() + 90_000
		});
		expect(response.status).toBe(429);
		expect(response.headers.get('retry-after')).toBe('90');
		expect(response.headers.get('cache-control')).toBe('private, no-store');
		await expect(response.json()).resolves.toEqual({
			message: 'Too many incorrect passcode attempts. Try again later.'
		});
	});
});
