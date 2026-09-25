import { dev } from '$app/environment';
import { Autumn, HTTPClient } from 'autumn-js';
import { Context, Effect, Layer } from 'effect';
import { AppConfig, type AutumnConfig } from '../config';
import { StorageError } from '../errors';
import type { Plan } from '../plans';

// The slice of Autumn the app depends on. The customer id is always the
// org id. The SDK is confined to autumnLive; without AUTUMN_SECRET_KEY the
// null client fails open (every check allows, every write is a no-op) so
// local quotas still apply, and a `fake:` key picks the in-memory fake
// only in development.

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
	// Permission checks alone fail open; local counters stay the hard stop.
	readonly check: (input: {
		readonly customerId: string;
		readonly featureId: FeatureId;
		readonly requiredBalance?: number;
	}) => Effect.Effect<FeatureCheck>;
	readonly updateBalance: (input: {
		readonly customerId: string;
		readonly featureId: FeatureId;
		readonly usage: number;
		readonly interval?: 'month';
		readonly nextResetAt?: number;
	}) => Effect.Effect<void, StorageError>;
	readonly getPlan: (input: {
		readonly customerId: string;
	}) => Effect.Effect<Plan, StorageError>;
	// Null means billing is disabled. Live checkout always requires review.
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

const REQUEST_TIMEOUT_MS = 5_000;
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;

// Bound both the HTTP request and its body. SDK timeouts otherwise stop at
// response headers, leaving a stalled body able to hold a database lock.
const boundedFetch = async (input: RequestInfo | URL, init?: RequestInit) => {
	const controller = new AbortController();
	const parentSignal =
		init?.signal ?? (input instanceof Request ? input.signal : null);
	const signal = parentSignal
		? AbortSignal.any([controller.signal, parentSignal])
		: controller.signal;
	let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
	let timer: ReturnType<typeof setTimeout> | undefined;
	const deadline = new Promise<never>((_, reject) => {
		timer = setTimeout(() => {
			controller.abort();
			reject(new Error('Autumn request timed out'));
		}, REQUEST_TIMEOUT_MS);
	});
	try {
		return await Promise.race([
			deadline,
			(async () => {
				const response = await fetch(input, { ...init, signal });
				if (signal.aborted) {
					void response.body?.cancel().catch(() => {});
					throw new Error('Autumn request aborted');
				}
				if (response.body === null) return response;
				reader = response.body.getReader();
				const chunks: Uint8Array[] = [];
				let size = 0;
				while (true) {
					const chunk = await reader.read();
					if (chunk.done) break;
					size += chunk.value.byteLength;
					if (size > MAX_RESPONSE_BYTES)
						throw new Error('Autumn response is too large');
					chunks.push(chunk.value);
				}
				const body = new Uint8Array(size);
				let offset = 0;
				for (const chunk of chunks) {
					body.set(chunk, offset);
					offset += chunk.byteLength;
				}
				return new Response(body, {
					status: response.status,
					statusText: response.statusText,
					headers: response.headers
				});
			})()
		]);
	} finally {
		clearTimeout(timer);
		controller.abort();
		void reader?.cancel().catch(() => {});
	}
};

// One SDK instance per isolate; it holds nothing but the key and a fetch.
let cachedSdk: { readonly key: string; readonly sdk: Autumn } | undefined;
const sdkFor = (secretKey: string) => {
	if (cachedSdk?.key !== secretKey) {
		cachedSdk = {
			key: secretKey,
			sdk: new Autumn({
				secretKey,
				failOpen: false,
				timeoutMs: REQUEST_TIMEOUT_MS,
				retryConfig: { strategy: 'none' },
				httpClient: new HTTPClient({ fetcher: boundedFetch })
			})
		};
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
		updateBalance: (input) =>
			Effect.tryPromise({
				try: () => autumn.balances.update(input),
				catch: failure('update Autumn balance')
			}).pipe(
				Effect.flatMap((result) =>
					result.success
						? Effect.void
						: Effect.fail(
								new StorageError({
									operation: 'update Autumn balance',
									cause: 'Autumn did not acknowledge the balance update'
								})
							)
				)
			),
		getPlan: (input) =>
			Effect.tryPromise({
				try: () => autumn.customers.get(input),
				catch: failure('read Autumn subscriptions')
			}).pipe(
				Effect.map((customer): Plan =>
					customer.subscriptions.some(
						(subscription) =>
							subscription.planId === 'pro' &&
							(subscription.scope === undefined ||
								subscription.scope === 'customer') &&
							(subscription.status === 'active' ||
								subscription.status === 'past_due')
					)
						? 'pro'
						: 'free'
				)
			),
		checkoutUrl: (input) =>
			Effect.tryPromise({
				try: () =>
					autumn.billing.attach({
						customerId: input.customerId,
						planId: input.planId,
						redirectMode: 'always',
						successUrl: input.successUrl
					}),
				catch: failure('start Autumn checkout')
			}).pipe(
				Effect.flatMap((result) =>
					result.paymentUrl
						? Effect.succeed(result.paymentUrl)
						: Effect.fail(
								new StorageError({
									operation: 'start Autumn checkout',
									cause: 'Autumn did not return a checkout URL'
								})
							)
				)
			),
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
	updateBalance: () => warnOnce,
	getPlan: () =>
		Effect.fail(
			new StorageError({
				operation: 'read Autumn subscriptions',
				cause: 'Autumn billing is not configured'
			})
		),
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
export const autumnFakePlans = new Map<string, Plan>();

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
	updateBalance: (input) => record('updateBalance', input),
	getPlan: (input) =>
		record('getPlan', input).pipe(
			Effect.map(() => autumnFakePlans.get(input.customerId) ?? 'free')
		),
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

export const clientFor = (
	config: AutumnConfig,
	development = false
): AutumnClientShape => {
	if (config.secretKey === null) return autumnNull;
	if (config.secretKey.startsWith(FAKE_AUTUMN_PREFIX)) {
		if (!development)
			throw new Error('Fake Autumn billing is only available in development');
		return autumnFake;
	}
	return autumnLive(config.secretKey);
};

export const AutumnLive = Layer.effect(
	AutumnClient,
	Effect.map(AppConfig, (config) => clientFor(config.autumn, dev))
);

export const AutumnNull = Layer.succeed(AutumnClient, autumnNull);
