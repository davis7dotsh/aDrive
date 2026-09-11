import { Cause, Effect, Exit } from 'effect';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const environment = vi.hoisted(() => ({ dev: false }));
vi.mock('$app/environment', () => ({
	get dev() {
		return environment.dev;
	}
}));

import { AppConfig, configFromEnv } from '../config';
import { StorageError } from '../errors';
import {
	UrlReputation,
	UrlReputationLive,
	type UrlReputationShape
} from './url-reputation';

const scannerConfig = { apiKey: 'url-test-token', accountId: 'account/one' };

const env = {
	DASHBOARD_ORIGIN: 'https://drive.example.test',
	CONTENT_DOMAIN: 'content.example.test',
	MAX_UPLOAD_BYTES: '99614720',
	MAINTENANCE_SECRET: 'url-test-maintenance-secret',
	SEMANTIC_SEARCH: 'auto',
	EMBEDDING_MODEL: '@cf/baai/bge-small-en-v1.5',
	EMBEDDING_POOLING: 'cls',
	EMBEDDING_DIMENSIONS: '384',
	WORKOS_API_KEY: 'sk_url_test',
	WORKOS_CLIENT_ID: 'client_url_test',
	WORKOS_COOKIE_PASSWORD: 'url-test-cookie-password-of-32-characters',
	WORKOS_WEBHOOK_SECRET: 'url-test-webhook-secret',
	URLSCAN_API_KEY: scannerConfig.apiKey,
	CF_ACCOUNT_ID: scannerConfig.accountId
} as Env;

const run = <A, E>(
	use: (service: UrlReputationShape) => Effect.Effect<A, E>,
	apiKey = scannerConfig.apiKey
) =>
	Effect.runPromiseExit(
		Effect.flatMap(UrlReputation, use).pipe(
			Effect.provide(UrlReputationLive),
			Effect.provideService(AppConfig, {
				...configFromEnv(env),
				// Deliberately bypass config validation to test the layer's own
				// production guard as well as the configuration tests.
				urlScanner: { apiKey, accountId: scannerConfig.accountId }
			})
		)
	);

const report = (success = true, hasVerdicts = true, malicious = false) => ({
	task: { success },
	verdicts: { overall: { hasVerdicts, malicious, categories: [] } }
});

describe('Cloudflare URL Scanner boundary', () => {
	beforeEach(() => {
		environment.dev = false;
	});
	afterEach(() => {
		vi.unstubAllGlobals();
		vi.restoreAllMocks();
	});

	it('submits using the documented Unlisted request enum', async () => {
		const fetcher = vi
			.fn()
			.mockResolvedValue(Response.json({ uuid: 'scan-1' }));
		vi.stubGlobal('fetch', fetcher);
		const outcome = await run((service) =>
			service.submit('https://target.example/')
		);
		expect(outcome).toMatchObject({ _tag: 'Success', value: 'scan-1' });
		expect(fetcher).toHaveBeenCalledWith(
			'https://api.cloudflare.com/client/v4/accounts/account%2Fone/urlscanner/v2/scan',
			expect.objectContaining({
				method: 'POST',
				body: JSON.stringify({
					url: 'https://target.example/',
					visibility: 'Unlisted'
				}),
				headers: expect.objectContaining({
					Authorization: 'Bearer url-test-token'
				}),
				signal: expect.any(AbortSignal)
			})
		);
	});

	it.each([
		{ success: true, hasVerdicts: true, malicious: false, verdict: 'clean' },
		{ success: true, hasVerdicts: true, malicious: true, verdict: 'malicious' },
		{
			success: false,
			hasVerdicts: true,
			malicious: false,
			verdict: 'suspicious'
		},
		{
			success: true,
			hasVerdicts: false,
			malicious: false,
			verdict: 'clean'
		},
		{
			success: true,
			hasVerdicts: false,
			malicious: true,
			verdict: 'malicious'
		}
	])(
		'classifies only positive completion evidence as clean: $verdict',
		async (input) => {
			vi.stubGlobal(
				'fetch',
				vi
					.fn()
					.mockResolvedValue(
						Response.json(
							report(input.success, input.hasVerdicts, input.malicious)
						)
					)
			);
			expect(await run((service) => service.result('scan-1'))).toMatchObject({
				_tag: 'Success',
				value: {
					_tag: 'Settled',
					verdict: input.verdict,
					details: { hasVerdicts: input.hasVerdicts }
				}
			});
		}
	);

	it.each([
		{},
		{ task: { success: true } },
		{ ...report(), task: {} },
		{ ...report(), verdicts: { overall: { malicious: false } } },
		{ ...report(), verdicts: { overall: { hasVerdicts: true } } }
	])('rejects a malformed or incomplete report: %j', async (body) => {
		vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json(body)));
		const outcome = await run((service) => service.result('scan-1'));
		expect(Exit.isFailure(outcome)).toBe(true);
		if (Exit.isFailure(outcome)) {
			expect(Cause.squash(outcome.cause)).toBeInstanceOf(StorageError);
		}
	});

	it.each([
		{ operation: 'result', status: 404, pending: true },
		{ operation: 'result', status: 503, pending: false },
		{ operation: 'submit', status: 429, pending: false }
	] as const)(
		'cancels the unused $operation response body for HTTP $status',
		async (input) => {
			const cancel = vi.fn();
			const response = new Response(
				new ReadableStream<Uint8Array>({ cancel }),
				{
					status: input.status
				}
			);
			vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response));
			const outcome = await run((service) =>
				input.operation === 'result'
					? service.result('scan-1').pipe(Effect.asVoid)
					: service.submit('https://target.example/').pipe(Effect.asVoid)
			);
			expect(cancel).toHaveBeenCalledOnce();
			expect(Exit.isSuccess(outcome)).toBe(input.pending);
			if (Exit.isFailure(outcome)) {
				expect(Cause.squash(outcome.cause)).toBeInstanceOf(StorageError);
			}
		}
	);

	it.each(['submit', 'result'] as const)(
		'bounds a stalled %s request with an abort signal',
		async (operation) => {
			const controller = new AbortController();
			const timeout = vi
				.spyOn(AbortSignal, 'timeout')
				.mockReturnValue(controller.signal);
			const started = Promise.withResolvers<void>();
			vi.stubGlobal(
				'fetch',
				vi.fn(
					(_url: string, init: RequestInit) =>
						new Promise<Response>((_resolve, reject) => {
							init.signal?.addEventListener(
								'abort',
								() => reject(init.signal?.reason),
								{ once: true }
							);
							started.resolve();
						})
				)
			);
			const pending = run((service) =>
				operation === 'submit'
					? service.submit('https://target.example/').pipe(Effect.asVoid)
					: service.result('scan-1').pipe(Effect.asVoid)
			);
			await started.promise;
			expect(timeout).toHaveBeenCalledWith(5_000);
			controller.abort(new DOMException('Timed out', 'TimeoutError'));
			const outcome = await pending;
			expect(Exit.isFailure(outcome)).toBe(true);
			if (Exit.isFailure(outcome)) {
				expect(Cause.squash(outcome.cause)).toBeInstanceOf(StorageError);
			}
		}
	);

	it('rejects a production fake even when configuration is injected directly', async () => {
		const fetcher = vi.fn();
		vi.stubGlobal('fetch', fetcher);
		const outcome = await run(
			(service) => service.result('scan-1'),
			'fake:clean'
		);
		expect(Exit.isFailure(outcome)).toBe(true);
		if (Exit.isFailure(outcome)) {
			expect(Cause.squash(outcome.cause)).toBeInstanceOf(StorageError);
		}
		expect(fetcher).not.toHaveBeenCalled();
	});

	it('keeps the explicit development fake available without fetching', async () => {
		environment.dev = true;
		const fetcher = vi.fn();
		vi.stubGlobal('fetch', fetcher);
		expect(
			await run((service) => service.result('scan-1'), 'fake:clean')
		).toMatchObject({
			_tag: 'Success',
			value: { _tag: 'Settled', verdict: 'clean' }
		});
		expect(fetcher).not.toHaveBeenCalled();
	});
});
