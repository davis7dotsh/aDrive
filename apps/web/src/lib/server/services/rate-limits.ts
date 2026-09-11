import { Context, Effect, Layer } from 'effect';
import { RateLimiters } from './bindings';

// Abuse brakes on the Workers rate limit bindings (wrangler.jsonc
// `ratelimits`). Each is keyed by the principal that would be abusing it:
// uploads and publishes by org, credential bootstrap by client, anonymous
// content fetches by IP. The bindings count per colo and are approximate,
// which is enough to stop a runaway client and not a billing input. A
// binding that errors lets the request through and logs: a broken brake
// must not take legitimate traffic down with it.

export interface RateLimitDecision {
	readonly allowed: boolean;
}

export interface RateLimitsShape {
	readonly upload: (orgId: string) => Effect.Effect<RateLimitDecision>;
	readonly publish: (orgId: string) => Effect.Effect<RateLimitDecision>;
	readonly auth: (clientId: string) => Effect.Effect<RateLimitDecision>;
	readonly anonymous: (ip: string) => Effect.Effect<RateLimitDecision>;
}

export type RateLimitName = keyof RateLimitsShape;

export class RateLimits extends Context.Service<RateLimits, RateLimitsShape>()(
	'app/RateLimits'
) {}

// The bindings reject keys over 64 bytes; hash longer principals so an
// oversized value cannot bypass the counter by erroring out.
const MAX_KEY_LENGTH = 64;

const normalizeKey = (value: string) => {
	const trimmed = value.normalize('NFKC').trim() || 'unknown';
	return new TextEncoder().encode(trimmed).byteLength <= MAX_KEY_LENGTH
		? trimmed
		: null;
};

const hashedKey = (value: string) =>
	Effect.promise(() =>
		crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))
	).pipe(
		Effect.map((digest) =>
			Array.from(new Uint8Array(digest), (byte) =>
				byte.toString(16).padStart(2, '0')
			).join('')
		)
	);

const limitWith = (name: RateLimitName, binding: RateLimit) =>
	Effect.fn(`RateLimits.${name}`)(function* (principal: string) {
		const key = normalizeKey(principal) ?? (yield* hashedKey(principal));
		return yield* Effect.tryPromise(() => binding.limit({ key })).pipe(
			Effect.map((outcome) => ({ allowed: outcome.success })),
			Effect.catchCause((cause) =>
				Effect.sync(() => {
					console.error(
						JSON.stringify({
							message: 'rate limit binding failed; allowing the request',
							limit: name,
							cause: String(cause)
						})
					);
					return { allowed: true };
				})
			)
		);
	});

export const RateLimitsLive = Layer.effect(
	RateLimits,
	Effect.map(RateLimiters, (bindings) =>
		RateLimits.of({
			upload: limitWith('upload', bindings.upload),
			publish: limitWith('publish', bindings.publish),
			auth: limitWith('auth', bindings.auth),
			anonymous: limitWith('anonymous', bindings.anonymous)
		})
	)
);

// For tests and tools that run outside the Worker. Every check is allowed
// unless its name is in `denied`, which a test flips to exercise the 429
// path deterministically instead of racing a real counter.
export const RateLimitsNull = (
	denied: ReadonlySet<RateLimitName> = new Set()
) => {
	const decide = (name: RateLimitName) => () =>
		Effect.succeed({ allowed: !denied.has(name) });
	return Layer.succeed(
		RateLimits,
		RateLimits.of({
			upload: decide('upload'),
			publish: decide('publish'),
			auth: decide('auth'),
			anonymous: decide('anonymous')
		})
	);
};

// A stand-in for one RateLimit binding, for route tests that hand the
// consumer and the routes a real Env: allowed unless `denied` says no.
export const rateLimitBinding = (denied: () => boolean): RateLimit => ({
	limit: async () => ({ success: !denied() })
});
