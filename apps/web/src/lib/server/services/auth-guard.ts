import { Context, Effect, Layer, Schema } from 'effect';
import { StorageError } from '../errors';
import { AuthGuardStore } from './bindings';

const CounterState = Schema.Struct({
	count: Schema.Int,
	resetAtMs: Schema.Int
});

const ratePolicies = {
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
	// leaked API key can pump objects into the bucket. KV allows roughly one
	// write per second per key and is eventually consistent, so this is an
	// approximate abuse brake, not an exact ceiling — legitimate concurrent
	// uploads must not be failed by a KV write conflict (tolerateWriteFailure),
	// and a burst may briefly exceed the nominal limit.
	upload: {
		key: 'upload',
		limit: 120,
		windowSeconds: 10 * 60,
		tolerateWriteFailure: true
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
	readonly reason: 'rate-limit';
	readonly retryAfterSeconds: number;
	readonly resetAtMs: number;
}

export type AuthAttemptDecision = AllowedAuthAttempt | BlockedAuthAttempt;

export interface AuthGuardShape {
	readonly consume: (
		policy: AuthRatePolicy,
		clientId: string
	) => Effect.Effect<AuthAttemptDecision, StorageError>;
}

export class AuthGuard extends Context.Service<AuthGuard, AuthGuardShape>()(
	'app/AuthGuard'
) {}

const MINIMUM_KV_TTL_SECONDS = 60;

const retryAfter = (resetAtMs: number, nowMs: number) =>
	Math.max(1, Math.ceil((resetAtMs - nowMs) / 1_000));

const allowed = (remaining: number, resetAtMs: number) =>
	({
		allowed: true,
		remaining,
		resetAtMs
	}) satisfies AllowedAuthAttempt;

const blocked = (resetAtMs: number, nowMs: number) =>
	({
		allowed: false,
		reason: 'rate-limit',
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
					return blocked(resetAtMs, currentTime);
				}

				const nextCount = count + 1;
				const persist = write(
					key,
					{ count: nextCount, resetAtMs },
					retryAfter(resetAtMs, currentTime) + MINIMUM_KV_TTL_SECONDS,
					`update ${policy.key} rate limit`
				);
				// High-frequency policies (uploads) hit KV's ~1 write/sec/key
				// ceiling under normal concurrent use; failing the counter
				// write must not fail the legitimate request there. Abuse
				// bootstrap policies (device flow) stay fail-closed: a
				// contended write turns into a short rate limit.
				if ('tolerateWriteFailure' in policy && policy.tolerateWriteFailure) {
					yield* persist.pipe(Effect.ignore);
					return allowed(policy.limit - nextCount, resetAtMs);
				}
				const outcome = yield* persist.pipe(
					Effect.match({
						onFailure: () =>
							blocked(
								currentTime + MINIMUM_KV_TTL_SECONDS * 1_000,
								currentTime
							),
						onSuccess: () => allowed(policy.limit - nextCount, resetAtMs)
					})
				);
				return outcome;
			})
		});
	});

export const AuthGuardLive = (now = () => new Date()) =>
	Layer.effect(AuthGuard, makeAuthGuard(now));
