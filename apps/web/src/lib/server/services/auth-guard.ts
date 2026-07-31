import { Context, Effect, Layer, Schema } from 'effect';
import { StorageError } from '../errors';
import { AuthGuardStore } from './bindings';

const CounterState = Schema.Struct({
	count: Schema.Int,
	resetAtMs: Schema.Int
});

const FailureState = Schema.Struct({
	failures: Schema.Int,
	windowStartedAtMs: Schema.Int,
	lockedUntilMs: Schema.NullOr(Schema.Int)
});

const ratePolicies = {
	passcodeLogin: {
		key: 'passcode-login',
		limit: 10,
		windowSeconds: 5 * 60
	},
	deviceCreate: {
		key: 'device-create',
		limit: 5,
		windowSeconds: 10 * 60
	},
	devicePoll: {
		key: 'device-poll',
		limit: 150,
		windowSeconds: 10 * 60
	},
	// Keyed by credential id, not client address: bounds how fast a single
	// leaked API key can pump objects into the bucket.
	upload: {
		key: 'upload',
		limit: 120,
		windowSeconds: 10 * 60
	}
};

export type AuthRatePolicy = keyof typeof ratePolicies;

export interface AllowedAuthAttempt {
	readonly allowed: true;
	readonly remaining: number;
	readonly resetAtMs: number;
}

export interface BlockedAuthAttempt {
	readonly allowed: false;
	readonly reason: 'lockout' | 'rate-limit';
	readonly retryAfterSeconds: number;
	readonly resetAtMs: number;
}

export type AuthAttemptDecision = AllowedAuthAttempt | BlockedAuthAttempt;

export interface AuthGuardShape {
	readonly consume: (
		policy: AuthRatePolicy,
		clientId: string
	) => Effect.Effect<AuthAttemptDecision, StorageError>;
	readonly checkPasscodeLock: (
		clientId: string
	) => Effect.Effect<AuthAttemptDecision, StorageError>;
	readonly recordPasscodeFailure: (
		clientId: string
	) => Effect.Effect<AuthAttemptDecision, StorageError>;
	readonly clearPasscodeFailures: (
		clientId: string
	) => Effect.Effect<void, StorageError>;
}

export class AuthGuard extends Context.Service<AuthGuard, AuthGuardShape>()(
	'app/AuthGuard'
) {}

const PASSCODE_FAILURE_LIMIT = 5;
const PASSCODE_FAILURE_WINDOW_SECONDS = 15 * 60;
const PASSCODE_LOCKOUT_SECONDS = 30 * 60;
const MINIMUM_KV_TTL_SECONDS = 60;

const retryAfter = (resetAtMs: number, nowMs: number) =>
	Math.max(1, Math.ceil((resetAtMs - nowMs) / 1_000));

const allowed = (remaining: number, resetAtMs: number) =>
	({
		allowed: true,
		remaining,
		resetAtMs
	}) satisfies AllowedAuthAttempt;

const blocked = (
	reason: BlockedAuthAttempt['reason'],
	resetAtMs: number,
	nowMs: number
) =>
	({
		allowed: false,
		reason,
		retryAfterSeconds: retryAfter(resetAtMs, nowMs),
		resetAtMs
	}) satisfies BlockedAuthAttempt;

const normalizeClientId = (value: string) =>
	value.normalize('NFKC').trim().slice(0, 256) || 'unknown-client';

const toHex = (bytes: ArrayBuffer) =>
	Array.from(new Uint8Array(bytes), (byte) =>
		byte.toString(16).padStart(2, '0')
	).join('');

const hashClientId = (value: string) =>
	Effect.promise(() =>
		crypto.subtle.digest(
			'SHA-256',
			new TextEncoder().encode(normalizeClientId(value))
		)
	).pipe(Effect.map(toHex));

const decodeStored = <A, I>(
	schema: Schema.Codec<A, I, never>,
	value: string | null
) => {
	if (value === null) return null;
	const parsed: unknown = JSON.parse(value);
	const decoded = Schema.decodeUnknownOption(schema)(parsed);
	if (decoded._tag === 'None')
		throw new Error('Stored auth guard state is invalid');
	return decoded.value;
};

const makeAuthGuard = (now: () => Date) =>
	Effect.gen(function* () {
		const store = yield* AuthGuardStore;

		const read = <A, I>(
			key: string,
			schema: Schema.Codec<A, I, never>,
			operation: string
		) =>
			Effect.tryPromise({
				try: async () => decodeStored(schema, await store.get(key)),
				catch: (cause) => new StorageError({ operation, cause })
			});

		const write = (
			key: string,
			value: unknown,
			expirationTtl: number,
			operation: string
		) =>
			Effect.tryPromise({
				try: () =>
					store.put(key, JSON.stringify(value), {
						expirationTtl: Math.max(
							MINIMUM_KV_TTL_SECONDS,
							Math.ceil(expirationTtl)
						)
					}),
				catch: (cause) => new StorageError({ operation, cause })
			});

		const writeOrBlock = (
			key: string,
			value: unknown,
			expirationTtl: number,
			operation: string,
			currentTime: number
		) =>
			write(key, value, expirationTtl, operation).pipe(
				Effect.match({
					onFailure: () =>
						blocked(
							'rate-limit',
							currentTime + MINIMUM_KV_TTL_SECONDS * 1_000,
							currentTime
						),
					onSuccess: () => null
				})
			);

		const remove = (key: string, operation: string) =>
			Effect.tryPromise({
				try: () => store.delete(key),
				catch: (cause) => new StorageError({ operation, cause })
			});

		const clientKey = Effect.fn('AuthGuard.clientKey')(function* (
			prefix: string,
			clientId: string
		) {
			const clientHash = yield* hashClientId(clientId);
			return `v1:${prefix}:${clientHash}`;
		});

		return AuthGuard.of({
			consume: Effect.fn('AuthGuard.consume')(function* (policyName, clientId) {
				const policy = ratePolicies[policyName];
				const key = yield* clientKey(policy.key, clientId);
				const currentTime = now().getTime();
				const current = yield* read(
					key,
					CounterState,
					`read ${policy.key} rate limit`
				);
				const resetAtMs =
					current === null || current.resetAtMs <= currentTime
						? currentTime + policy.windowSeconds * 1_000
						: current.resetAtMs;
				const count =
					current === null || current.resetAtMs <= currentTime
						? 0
						: current.count;

				if (count >= policy.limit) {
					return blocked('rate-limit', resetAtMs, currentTime);
				}

				const nextCount = count + 1;
				const writeFailure = yield* writeOrBlock(
					key,
					{ count: nextCount, resetAtMs },
					retryAfter(resetAtMs, currentTime) + MINIMUM_KV_TTL_SECONDS,
					`update ${policy.key} rate limit`,
					currentTime
				);
				if (writeFailure) return writeFailure;
				return allowed(policy.limit - nextCount, resetAtMs);
			}),
			checkPasscodeLock: Effect.fn('AuthGuard.checkPasscodeLock')(
				function* (clientId) {
					const key = yield* clientKey('passcode-failures', clientId);
					const currentTime = now().getTime();
					const state = yield* read(key, FailureState, 'read passcode lockout');
					if (state?.lockedUntilMs && state.lockedUntilMs > currentTime) {
						return blocked('lockout', state.lockedUntilMs, currentTime);
					}
					return allowed(PASSCODE_FAILURE_LIMIT, currentTime);
				}
			),
			recordPasscodeFailure: Effect.fn('AuthGuard.recordPasscodeFailure')(
				function* (clientId) {
					const key = yield* clientKey('passcode-failures', clientId);
					const currentTime = now().getTime();
					const current = yield* read(
						key,
						FailureState,
						'read passcode failures'
					);
					if (current?.lockedUntilMs && current.lockedUntilMs > currentTime) {
						return blocked('lockout', current.lockedUntilMs, currentTime);
					}

					const inWindow =
						current !== null &&
						currentTime - current.windowStartedAtMs <
							PASSCODE_FAILURE_WINDOW_SECONDS * 1_000;
					const failures = inWindow ? current.failures + 1 : 1;
					const windowStartedAtMs = inWindow
						? current.windowStartedAtMs
						: currentTime;
					const lockedUntilMs =
						failures >= PASSCODE_FAILURE_LIMIT
							? currentTime + PASSCODE_LOCKOUT_SECONDS * 1_000
							: null;
					const state = { failures, windowStartedAtMs, lockedUntilMs };
					const expiresAtMs =
						lockedUntilMs ??
						windowStartedAtMs + PASSCODE_FAILURE_WINDOW_SECONDS * 1_000;

					const writeFailure = yield* writeOrBlock(
						key,
						state,
						retryAfter(expiresAtMs, currentTime) + MINIMUM_KV_TTL_SECONDS,
						'update passcode failures',
						currentTime
					);
					if (writeFailure) return writeFailure;

					return lockedUntilMs === null
						? allowed(PASSCODE_FAILURE_LIMIT - failures, expiresAtMs)
						: blocked('lockout', lockedUntilMs, currentTime);
				}
			),
			clearPasscodeFailures: Effect.fn('AuthGuard.clearPasscodeFailures')(
				function* (clientId) {
					const key = yield* clientKey('passcode-failures', clientId);
					yield* remove(key, 'clear passcode failures');
				}
			)
		});
	});

export const AuthGuardLive = (now = () => new Date()) =>
	Layer.effect(AuthGuard, makeAuthGuard(now));
