import { Effect } from 'effect';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { autumnFake, autumnNull, clientFor } from './autumn';

const client = () =>
	clientFor({ secretKey: 'sk_provider_test', webhookSecret: '' });
const customerId = 'org_provider_test';
const requestJson = async (input: RequestInfo | URL, init?: RequestInit) => {
	const request = input instanceof Request ? input : new Request(input, init);
	return request.clone().json();
};
const subscription = (overrides: Record<string, unknown> = {}) => ({
	id: 'sub_pro',
	plan_id: 'pro',
	auto_enable: false,
	add_on: false,
	status: 'active',
	past_due: false,
	canceled_at: null,
	expires_at: null,
	trial_ends_at: null,
	started_at: 1,
	current_period_start: 1,
	current_period_end: 2,
	quantity: 1,
	scope: 'customer',
	...overrides
});
const customer = (subscriptions: Array<Record<string, unknown>>) => ({
	id: customerId,
	name: 'Provider test',
	email: null,
	created_at: 1,
	fingerprint: null,
	stripe_id: null,
	env: 'sandbox',
	metadata: {},
	send_email_receipts: false,
	billing_controls: {},
	subscriptions,
	purchases: [],
	licenses: [],
	balances: {},
	flags: {}
});

const operations = [
	{
		name: 'customer creation',
		run: () =>
			client().ensureCustomer({
				customerId,
				name: 'Test',
				email: 'test@example.test'
			})
	},
	{
		name: 'balance update',
		run: () =>
			client().updateBalance({ customerId, featureId: 'ai_ops', usage: 7 })
	},
	{ name: 'subscription read', run: () => client().getPlan({ customerId }) },
	{
		name: 'checkout',
		run: () =>
			client().checkoutUrl({
				customerId,
				planId: 'pro',
				successUrl: 'https://drive.example.test/'
			})
	},
	{
		name: 'billing portal',
		run: () =>
			client().portalUrl({
				customerId,
				returnUrl: 'https://drive.example.test/'
			})
	}
];

afterEach(() => {
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
	vi.useRealTimers();
});

describe('Autumn provider boundary', () => {
	it.each(operations)(
		'surfaces $name failures without SDK fail-open or retries',
		async ({ run }) => {
			const fetcher = vi.fn(async () =>
				Response.json({ message: 'Unavailable' }, { status: 503 })
			);
			vi.stubGlobal('fetch', fetcher);
			await expect(Effect.runPromise(run())).rejects.toMatchObject({
				_tag: 'StorageError'
			});
			expect(fetcher).toHaveBeenCalledTimes(1);
		}
	);

	it('fails open only for permission checks', async () => {
		const fetcher = vi.fn(async () => {
			throw new Error('offline');
		});
		vi.stubGlobal('fetch', fetcher);
		vi.spyOn(console, 'error').mockImplementation(() => {});
		expect(
			await Effect.runPromise(
				client().check({ customerId, featureId: 'ai_ops' })
			)
		).toEqual({ allowed: true, remaining: null });
		expect(fetcher).toHaveBeenCalledTimes(1);
	});

	it.each(operations)(
		'bounds stalled $name response bodies and cancels the stream',
		async ({ run }) => {
			vi.useFakeTimers();
			const started = Promise.withResolvers<void>();
			const cancel = vi.fn();
			vi.stubGlobal(
				'fetch',
				vi.fn(async () => {
					started.resolve();
					return new Response(new ReadableStream<Uint8Array>({ cancel }), {
						headers: { 'Content-Type': 'application/json' }
					});
				})
			);
			const pending = Effect.runPromise(run());
			const rejected = expect(pending).rejects.toMatchObject({
				_tag: 'StorageError'
			});
			await started.promise;
			await vi.advanceTimersByTimeAsync(5_001);
			await rejected;
			expect(cancel).toHaveBeenCalledOnce();
		}
	);

	it('bounds a fetch that never returns headers', async () => {
		vi.useFakeTimers();
		const started = Promise.withResolvers<void>();
		let signal: AbortSignal | null | undefined;
		vi.stubGlobal(
			'fetch',
			vi.fn((_input: RequestInfo | URL, init?: RequestInit) => {
				signal = init?.signal;
				started.resolve();
				return new Promise<Response>(() => {});
			})
		);
		const pending = Effect.runPromise(client().getPlan({ customerId }));
		const rejected = expect(pending).rejects.toMatchObject({
			_tag: 'StorageError'
		});
		await started.promise;
		await vi.advanceTimersByTimeAsync(5_001);
		await rejected;
		expect(signal?.aborted).toBe(true);
	});

	it('rejects an oversized provider response and cancels unread data', async () => {
		const cancel = vi.fn();
		vi.stubGlobal(
			'fetch',
			vi.fn(
				async () =>
					new Response(
						new ReadableStream<Uint8Array>({
							start(controller) {
								controller.enqueue(new Uint8Array(2 * 1024 * 1024 + 1));
							},
							cancel
						}),
						{ headers: { 'Content-Type': 'application/json' } }
					)
			)
		);
		await expect(
			Effect.runPromise(client().getPlan({ customerId }))
		).rejects.toMatchObject({ _tag: 'StorageError' });
		expect(cancel).toHaveBeenCalledOnce();
	});

	it('sets absolute monthly usage and its UTC reset without additive tracking', async () => {
		const fetcher = vi.fn(
			async (_input: RequestInfo | URL, _init?: RequestInit) =>
				Response.json({ success: true })
		);
		vi.stubGlobal('fetch', fetcher);
		const input = {
			customerId,
			featureId: 'ai_ops' as const,
			usage: 37,
			interval: 'month' as const,
			nextResetAt: Date.UTC(2026, 9, 1)
		};
		await Effect.runPromise(client().updateBalance(input));
		await Effect.runPromise(client().updateBalance(input));
		for (const call of fetcher.mock.calls) {
			const [request, init] = call;
			expect(await requestJson(request, init)).toEqual({
				customer_id: customerId,
				feature_id: 'ai_ops',
				usage: 37,
				interval: 'month',
				next_reset_at: Date.UTC(2026, 9, 1)
			});
		}
	});

	it('does not acknowledge a rejected or malformed balance update', async () => {
		for (const response of [{ success: false }, {}]) {
			vi.stubGlobal(
				'fetch',
				vi.fn(async () => Response.json(response))
			);
			await expect(
				Effect.runPromise(
					client().updateBalance({ customerId, featureId: 'ai_ops', usage: 3 })
				)
			).rejects.toMatchObject({ _tag: 'StorageError' });
		}
	});

	it.each([
		{ name: 'active', subscription: subscription(), plan: 'pro' },
		{
			name: 'past due boolean',
			subscription: subscription({ past_due: true }),
			plan: 'pro'
		},
		{
			name: 'past due status',
			subscription: subscription({ status: 'past_due' }),
			plan: 'pro'
		},
		{
			name: 'cancel at period end',
			subscription: subscription({ canceled_at: 1, expires_at: 2 }),
			plan: 'pro'
		},
		{
			name: 'trial',
			subscription: subscription({ trial_ends_at: 2 }),
			plan: 'pro'
		},
		{
			name: 'scheduled',
			subscription: subscription({ status: 'scheduled' }),
			plan: 'free'
		},
		{
			name: 'expired',
			subscription: subscription({ status: 'expired' }),
			plan: 'free'
		},
		{
			name: 'entity',
			subscription: subscription({ scope: 'entity' }),
			plan: 'free'
		},
		{
			name: 'unknown plan',
			subscription: subscription({ plan_id: 'enterprise' }),
			plan: 'free'
		}
	])(
		'resolves $name subscriptions from authoritative customer state',
		async ({ subscription, plan }) => {
			vi.stubGlobal(
				'fetch',
				vi.fn(async () => Response.json(customer([subscription])))
			);
			expect(await Effect.runPromise(client().getPlan({ customerId }))).toBe(
				plan
			);
		}
	);

	it('returns Free only after a valid customer response without Pro', async () => {
		vi.stubGlobal(
			'fetch',
			vi.fn(async () => Response.json(customer([])))
		);
		expect(await Effect.runPromise(client().getPlan({ customerId }))).toBe(
			'free'
		);
		vi.stubGlobal(
			'fetch',
			vi.fn(async () => Response.json({ subscriptions: [] }))
		);
		await expect(
			Effect.runPromise(client().getPlan({ customerId }))
		).rejects.toMatchObject({ _tag: 'StorageError' });
		await expect(
			Effect.runPromise(autumnNull.getPlan({ customerId }))
		).rejects.toMatchObject({ _tag: 'StorageError' });
	});

	it('always requests a hosted checkout review, including customers with saved cards', async () => {
		const fetcher = vi.fn(
			async (_input: RequestInfo | URL, _init?: RequestInit) =>
				Response.json({
					customer_id: customerId,
					payment_url: 'https://checkout.stripe.com/test'
				})
		);
		vi.stubGlobal('fetch', fetcher);
		expect(
			await Effect.runPromise(
				client().checkoutUrl({
					customerId,
					planId: 'pro',
					successUrl: 'https://drive.example.test/'
				})
			)
		).toBe('https://checkout.stripe.com/test');
		const [request, init] = fetcher.mock.calls[0]!;
		expect(await requestJson(request, init)).toMatchObject({
			redirect_mode: 'always'
		});
	});

	it('treats a missing live checkout URL as unavailable', async () => {
		vi.stubGlobal(
			'fetch',
			vi.fn(async () =>
				Response.json({ customer_id: customerId, payment_url: null })
			)
		);
		await expect(
			Effect.runPromise(
				client().checkoutUrl({
					customerId,
					planId: 'pro',
					successUrl: 'https://drive.example.test/'
				})
			)
		).rejects.toMatchObject({ _tag: 'StorageError' });
	});

	it('rejects fake keys at direct construction unless development is explicit', () => {
		const config = { secretKey: 'fake:test', webhookSecret: '' };
		expect(() => clientFor(config)).toThrow('only available in development');
		expect(() => clientFor(config, false)).toThrow(
			'only available in development'
		);
		expect(clientFor(config, true)).toBe(autumnFake);
	});
});
