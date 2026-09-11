import { dev } from '$app/environment';
import { Context, Effect, Layer, Schema } from 'effect';
import { AppConfig, type UrlScannerConfig } from '../config';
import { StorageError } from '../errors';

// Reputation of the links a published page points at, through the
// Cloudflare URL Scanner. A scan is asynchronous: submit returns an id and
// the verdict is collected later (the scan job re-sends itself with the
// ids). Without URLSCAN_API_KEY the Null implementation answers clean and
// the scanner records that the check was skipped.

export type UrlVerdict = 'clean' | 'suspicious' | 'malicious';

export type UrlScanResult =
	| { readonly _tag: 'Pending' }
	| {
			readonly _tag: 'Settled';
			readonly verdict: UrlVerdict;
			readonly details: Record<string, unknown>;
	  };

export interface UrlReputationShape {
	readonly enabled: boolean;
	readonly submit: (url: string) => Effect.Effect<string, StorageError>;
	readonly result: (id: string) => Effect.Effect<UrlScanResult, StorageError>;
}

export class UrlReputation extends Context.Service<
	UrlReputation,
	UrlReputationShape
>()('app/UrlReputation') {}

const Submission = Schema.Struct({ uuid: Schema.String });

const Report = Schema.Struct({
	task: Schema.Struct({ success: Schema.Boolean }),
	verdicts: Schema.Struct({
		overall: Schema.Struct({
			malicious: Schema.Boolean,
			categories: Schema.optionalKey(Schema.Array(Schema.String)),
			hasVerdicts: Schema.Boolean
		})
	})
});

const decodeSubmission = Schema.decodeUnknownOption(Submission);
const decodeReport = Schema.decodeUnknownOption(Report);

const failure = (operation: string) => (cause: unknown) =>
	new StorageError({ operation, cause });

const REQUEST_TIMEOUT_MS = 5_000;

const discardBody = (response: Response) =>
	Effect.tryPromise(async () => {
		await response.body?.cancel();
	}).pipe(Effect.ignore);

const urlScannerLive = (config: UrlScannerConfig): UrlReputationShape => {
	const base = `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(config.accountId)}/urlscanner/v2`;
	const headers = {
		Authorization: `Bearer ${config.apiKey}`,
		'Content-Type': 'application/json'
	};
	return {
		enabled: true,
		submit: Effect.fn('UrlReputation.submit')(function* (url) {
			// The provider's request enum is capitalized: Public | Unlisted.
			// Unlisted keeps the link out of public scan listings.
			const response = yield* Effect.tryPromise({
				try: () =>
					fetch(`${base}/scan`, {
						method: 'POST',
						headers,
						body: JSON.stringify({ url, visibility: 'Unlisted' }),
						signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
					}),
				catch: failure('submit URL scan')
			});
			if (!response.ok) {
				yield* discardBody(response);
				return yield* new StorageError({
					operation: 'submit URL scan',
					cause: `URL Scanner returned ${response.status}`
				});
			}
			const body = yield* Effect.tryPromise({
				try: (): Promise<unknown> => response.json(),
				catch: failure('read URL scan submission')
			});
			const decoded = decodeSubmission(body);
			if (decoded._tag === 'None' || decoded.value.uuid.trim() === '') {
				return yield* new StorageError({
					operation: 'submit URL scan',
					cause: 'URL Scanner did not return a scan id'
				});
			}
			return decoded.value.uuid;
		}),
		result: Effect.fn('UrlReputation.result')(function* (id) {
			const response = yield* Effect.tryPromise({
				try: () =>
					fetch(`${base}/result/${encodeURIComponent(id)}`, {
						headers,
						signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
					}),
				catch: failure('read URL scan result')
			});
			// The report is a 404 until the scan finishes.
			if (response.status === 404) {
				yield* discardBody(response);
				return { _tag: 'Pending' as const };
			}
			if (!response.ok) {
				yield* discardBody(response);
				return yield* new StorageError({
					operation: 'read URL scan result',
					cause: `URL Scanner returned ${response.status}`
				});
			}
			const body = yield* Effect.tryPromise({
				try: (): Promise<unknown> => response.json(),
				catch: failure('decode URL scan result')
			});
			const decoded = decodeReport(body);
			if (decoded._tag === 'None') {
				return yield* new StorageError({
					operation: 'read URL scan result',
					cause: 'URL Scanner report has an unexpected shape'
				});
			}
			const report = decoded.value;
			const overall = report.verdicts.overall;
			// A scan that could not run (DNS failure, timeout) proves nothing
			// either way; it is left for a person rather than passed.
			if (!report.task.success) {
				return {
					_tag: 'Settled' as const,
					verdict: 'suspicious' as const,
					details: {
						id,
						reason: 'scan-failed',
						hasVerdicts: overall.hasVerdicts
					}
				};
			}
			// Cloudflare documents task.success as completion and malicious as
			// the decision. hasVerdicts is metadata, not a completion gate.
			return {
				_tag: 'Settled' as const,
				verdict: overall.malicious ? 'malicious' : 'clean',
				details: {
					id,
					categories: overall.categories ?? [],
					hasVerdicts: overall.hasVerdicts
				}
			};
		})
	};
};

export const urlReputationNull: UrlReputationShape = {
	enabled: false,
	submit: () =>
		Effect.fail(
			new StorageError({
				operation: 'submit URL scan',
				cause: 'URL scanning is not configured'
			})
		),
	result: () =>
		Effect.succeed({
			_tag: 'Settled' as const,
			verdict: 'clean' as const,
			details: {}
		})
};

// Only tests and local development select the fake with URLSCAN_API_KEY set to
// `fake:<verdict>` (clean, suspicious, malicious). Every submitted link
// settles with that verdict on the first poll.
export const FAKE_URLSCAN_PREFIX = 'fake:';

const fakeVerdict = (apiKey: string): UrlVerdict => {
	const value = apiKey.slice(FAKE_URLSCAN_PREFIX.length);
	return value === 'malicious' || value === 'suspicious' ? value : 'clean';
};

export const urlReputationFake = (verdict: UrlVerdict): UrlReputationShape => ({
	enabled: true,
	submit: (url) => Effect.succeed(`fake-scan:${url}`),
	result: (id) =>
		Effect.succeed({
			_tag: 'Settled' as const,
			verdict,
			details: { id, fake: true }
		})
});

export const UrlReputationLive = Layer.effect(
	UrlReputation,
	Effect.flatMap(AppConfig, (config) => {
		const scanner = config.urlScanner;
		if (scanner === null) return Effect.succeed(urlReputationNull);
		if (scanner.apiKey.startsWith(FAKE_URLSCAN_PREFIX)) {
			if (!dev) {
				return Effect.fail(
					new StorageError({
						operation: 'configure URL scanning',
						cause: 'Fake URL scanning is only available in development'
					})
				);
			}
			return Effect.succeed(urlReputationFake(fakeVerdict(scanner.apiKey)));
		}
		return Effect.succeed(urlScannerLive(scanner));
	})
);
