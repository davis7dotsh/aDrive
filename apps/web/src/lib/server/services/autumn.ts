import { Autumn } from 'autumn-js';
import { Context, Effect, Layer } from 'effect';
import { AppConfig, type AutumnConfig } from '../config';
import { StorageError } from '../errors';

// The slice of Autumn the app depends on. The customer id is always the
// org id. The SDK is confined to autumnLive; without AUTUMN_SECRET_KEY the
// null client fails open (every check allows, every write is a no-op) so
// the app runs unmetered rather than not at all, and a `fake:` key picks
// the in-memory fake for tests.

export type FeatureId = 'storage_bytes' | 'ai_ops' | 'public_sharing';

export interface FeatureCheck {
	readonly allowed: boolean;
	// Units left on the feature, or null when Autumn did not say (a boolean
	// feature, an unknown balance, or a fail-open answer).
	readonly remaining: number | null;
}

export interface AutumnClientShape {
	readonly enabled: boolean;
	readonly ensureCustomer: (input: {
		readonly customerId: string;
		readonly name: string;
		readonly email: string;
	}) => Effect.Effect<void, StorageError>;
	// Never fails: an unreachable Autumn answers `allowed` (its own
	// fail-open default), so the local counters stay the hard stop.
	readonly check: (input: {
		readonly customerId: string;
		readonly featureId: FeatureId;
		readonly requiredBalance?: number;
	}) => Effect.Effect<FeatureCheck>;
	readonly track: (input: {
		readonly customerId: string;
		readonly featureId: FeatureId;
		readonly value: number;
	}) => Effect.Effect<void, StorageError>;
	readonly updateBalance: (input: {
		readonly customerId: string;
		readonly featureId: FeatureId;
		readonly usage: number;
	}) => Effect.Effect<void, StorageError>;
	// The hosted checkout URL, or null when no payment step was needed and
	// the plan is already attached.
	readonly checkoutUrl: (input: {
		readonly customerId: string;
		readonly planId: string;
		readonly successUrl: string;
	}) => Effect.Effect<string | null, StorageError>;
	readonly portalUrl: (input: {
		readonly customerId: string;
		readonly returnUrl: string;
	}) => Effect.Effect<string | null, StorageError>;
}

export class AutumnClient extends Context.Service<
	AutumnClient,
	AutumnClientShape
>()('app/AutumnClient') {}

const failure = (operation: string) => (cause: unknown) =>
	new StorageError({ operation, cause });

const log = (entry: Record<string, unknown>) =>
	Effect.sync(() => {
		console.error(JSON.stringify(entry));
	});

// One SDK instance per isolate; it holds nothing but the key and a fetch.
let cachedSdk: { readonly key: string; readonly sdk: Autumn } | undefined;
const sdkFor = (secretKey: string) => {
	if (cachedSdk?.key !== secretKey) {
		cachedSdk = { key: secretKey, sdk: new Autumn({ secretKey }) };
	}
	return cachedSdk.sdk;
};

const autumnLive = (secretKey: string): AutumnClientShape => {
	const autumn = sdkFor(secretKey);
	return {
		enabled: true,
		ensureCustomer: (input) =>
			Effect.tryPromise({
				try: () => autumn.customers.getOrCreate(input),
				catch: failure('create Autumn customer')
			}).pipe(Effect.asVoid),
		check: (input) =>
			Effect.tryPromise(() => autumn.check(input)).pipe(
				Effect.map((result): FeatureCheck => ({
					allowed: result.allowed,
					remaining: result.balance?.remaining ?? null
				})),
				Effect.catchCause((cause) =>
					log({
						message: 'Autumn check failed open',
						featureId: input.featureId,
						customerId: input.customerId,
						cause: String(cause)
					}).pipe(Effect.as({ allowed: true, remaining: null }))
				)
			),
		track: (input) =>
			Effect.tryPromise({
				try: () => autumn.track(input),
				catch: failure('track Autumn usage')
			}).pipe(Effect.asVoid),
		updateBalance: (input) =>
			Effect.tryPromise({
				try: () => autumn.balances.update(input),
				catch: failure('update Autumn balance')
			}).pipe(Effect.asVoid),
		checkoutUrl: (input) =>
			Effect.tryPromise({
				try: () =>
					autumn.billing.attach({
						customerId: input.customerId,
						planId: input.planId,
						redirectMode: 'if_required',
						successUrl: input.successUrl
					}),
				catch: failure('start Autumn checkout')
			}).pipe(Effect.map((result) => result.paymentUrl)),
		portalUrl: (input) =>
			Effect.tryPromise({
				try: () => autumn.billing.openCustomerPortal(input),
				catch: failure('open Autumn customer portal')
			}).pipe(Effect.map((result) => result.url))
	};
};

// Billing not configured: everything is allowed and nothing is recorded.
// Logged once per isolate so a production deploy without the key is
// visible without flooding the logs.
let warnedNull = false;
const warnOnce = Effect.sync(() => {
	if (warnedNull) return;
	warnedNull = true;
	console.warn(
		JSON.stringify({
			message: 'AUTUMN_SECRET_KEY is not set; billing gates fail open'
		})
	);
});

export const autumnNull: AutumnClientShape = {
	enabled: false,
	ensureCustomer: () => warnOnce,
	check: () => warnOnce.pipe(Effect.as({ allowed: true, remaining: null })),
	track: () => warnOnce,
	updateBalance: () => warnOnce,
	checkoutUrl: () => warnOnce.pipe(Effect.as(null)),
	portalUrl: () => warnOnce.pipe(Effect.as(null))
};

// Tests: every call is recorded, checkout and portal answer with stable
// URLs, and checks consult a per-feature table the test can set.
export const FAKE_AUTUMN_PREFIX = 'fake:';

export interface AutumnFakeCall {
	readonly method: keyof Omit<AutumnClientShape, 'enabled'>;
	readonly input: Record<string, unknown>;
}

export const autumnFakeCalls: Array<AutumnFakeCall> = [];
export const autumnFakeAllowed = new Map<FeatureId, boolean>();

const record = (
	method: AutumnFakeCall['method'],
	input: Record<string, unknown>
) =>
	Effect.sync(() => {
		autumnFakeCalls.push({ method, input });
	});

export const autumnFake: AutumnClientShape = {
	enabled: true,
	ensureCustomer: (input) => record('ensureCustomer', input),
	check: (input) =>
		record('check', input).pipe(
			Effect.as({
				allowed: autumnFakeAllowed.get(input.featureId) ?? true,
				remaining: null
			})
		),
	track: (input) => record('track', input),
	updateBalance: (input) => record('updateBalance', input),
	checkoutUrl: (input) =>
		record('checkoutUrl', input).pipe(
			Effect.as(
				`https://checkout.autumn.invalid/${input.customerId}/${input.planId}`
			)
		),
	portalUrl: (input) =>
		record('portalUrl', input).pipe(
			Effect.as(`https://portal.autumn.invalid/${input.customerId}`)
		)
};

export const clientFor = (config: AutumnConfig): AutumnClientShape => {
	if (config.secretKey === null) return autumnNull;
	if (config.secretKey.startsWith(FAKE_AUTUMN_PREFIX)) return autumnFake;
	return autumnLive(config.secretKey);
};

export const AutumnLive = Layer.effect(
	AutumnClient,
	Effect.map(AppConfig, (config) => clientFor(config.autumn))
);

export const AutumnNull = Layer.succeed(AutumnClient, autumnNull);
