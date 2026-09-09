import type { Job } from '@adrive/shared';
import type { Cookies, RequestEvent } from '@sveltejs/kit';
import { vi } from 'vitest';

export const DASHBOARD_ORIGIN = 'http://localhost:5173';
// Content is served from `<slug>.<CONTENT_DOMAIN>`; browsers resolve
// `*.localhost` to loopback, which is also what the suite pins.
export const CONTENT_DOMAIN = 'localhost:5174';
export const contentOrigin = (slug: string) =>
	`http://${slug}.${CONTENT_DOMAIN}`;

import type { JobDecision } from '../jobs/consumer';
import { rateLimitBinding, type RateLimitName } from '../services/rate-limits';

// Route handlers read the event through two paths: runEdgeWithEvent takes
// the event directly, and runEdge calls SvelteKit's getRequestEvent() —
// which vitest resolves to this module via the vi.mock('$app/server') in
// the test file.
let currentEvent: RequestEvent | undefined;

export const setRequestEvent = (event: RequestEvent) => {
	currentEvent = event;
};

class TestCookieStore implements Cookies {
	readonly jar = new Map<string, string>();
	get(name: string) {
		return this.jar.get(name);
	}
	getAll() {
		return [...this.jar].map(([name, value]) => ({ name, value }));
	}
	set(name: string, value: string) {
		this.jar.set(name, value);
	}
	delete(name: string) {
		this.jar.delete(name);
	}
	serialize(...args: Parameters<Cookies['serialize']>) {
		return `${args[0]}=${args[1]}`;
	}
}

const waitUntilQueue: Array<Promise<unknown>> = [];

export interface SentJob {
	readonly body: Job;
	readonly delaySeconds: number;
}

export interface RouteTestContext {
	readonly env: Env;
	readonly cookies: TestCookieStore;
	readonly url: (path: string) => URL;
	readonly event: (input: EventInput) => RequestEvent;
	// A request on `<slug>.<CONTENT_DOMAIN>`, as the hook would hand it to
	// a content route: the slug is resolved to locals.content first, so an
	// unknown or suspended slug rejects with the hook's 404.
	readonly contentEvent: (input: ContentEventInput) => Promise<RequestEvent>;
	readonly drainWaitUntil: () => Promise<void>;
	// Every job the app sent since the last drain, in order. The delay is
	// recorded, never waited for.
	readonly jobs: Array<SentJob>;
	// Runs the consumer in-process over every collected job as if its
	// delay had elapsed, then over anything those runs sent or asked to
	// retry, until nothing is left to run. A job the consumer re-sends
	// with a delay (a purge that arrived before its deadline) stays in
	// `jobs` for a later drain, since the clock has not moved. Returns
	// every decision.
	readonly drainJobs: () => Promise<ReadonlyArray<JobDecision>>;
	// The rate limit bindings are swapped for fakes that allow everything;
	// add a name here to have that limit refuse until it is removed.
	readonly deniedRateLimits: Set<RateLimitName>;
}

// The JOBS binding from getPlatformProxy is a real local queue nothing
// consumes, so tests swap it for this: sends are collected and drainJobs
// feeds them through the same consumer the Worker facade calls.
const collectingQueue = (sent: Array<SentJob>) => {
	const push = (body: unknown, options?: QueueSendOptions) => {
		sent.push({ body: body as Job, delaySeconds: options?.delaySeconds ?? 0 });
	};
	const metrics = async () => ({ backlogCount: sent.length, backlogBytes: 0 });
	const queue: Queue<Job> = {
		metrics,
		send: async (body, options) => {
			push(body, options);
			return { metadata: { metrics: await metrics() } };
		},
		sendBatch: async (messages, options) => {
			for (const message of messages) push(message.body, options);
			return { metadata: { metrics: await metrics() } };
		}
	};
	return queue;
};

export interface EventInput {
	method?: string;
	path: string;
	body?: BodyInit | null;
	headers?: Record<string, string>;
	params?: Record<string, string>;
	// Absolute URL to request instead of `path` on the dashboard origin.
	url?: URL;
}

// Either a slug plus a path, or a full content URL (as returned by the
// link and thumbnail routes) whose host names the slug.
export interface ContentEventInput extends EventInput {
	slug?: string;
}

// SvelteKit types RequestEvent per route with phantom params, which a
// generic test event can never satisfy; the runtime shape is what matters,
// so this is the single sanctioned cast point. The handle hook does not
// run here, so its identity step is replayed first: on the dashboard
// origin locals.auth is resolved from the Authorization header or the
// cookie jar (content events carry locals.content from contentEvent and
// never see credentials). The import is deferred because test files mock
// $app/server with a factory that imports this module, and request-auth
// reaches $app/server through edge.
export const call = async <E, R>(
	handler: (event: E) => R,
	event: RequestEvent
): Promise<R extends Promise<infer A> ? A : R> => {
	if (
		event.locals.auth === null &&
		event.locals.content === null &&
		event.platform?.env
	) {
		const { resolveEventAuth } = await import('../request-auth');
		const resolved = await resolveEventAuth(event.platform.env, event);
		event.locals.auth = resolved.auth;
	}
	return (handler as (event: RequestEvent) => R)(event) as Promise<
		R extends Promise<infer A> ? A : R
	>;
};

export const createRouteContext = async (): Promise<RouteTestContext> => {
	const { getTestPlatform } = await import('./platform');
	const proxy = await getTestPlatform();
	const platformEnv = proxy.env as Env;
	// Origins are pinned so a developer's .dev.vars overrides (for example
	// a Tailscale hostname) do not change what the suite asserts.
	// The WorkOS fake is forced so a developer's real credentials in
	// .dev.vars never leak into the suite.
	const jobs: Array<SentJob> = [];
	const deniedRateLimits = new Set<RateLimitName>();
	const limiter = (name: RateLimitName) =>
		rateLimitBinding(() => deniedRateLimits.has(name));
	const env = {
		...platformEnv,
		JOBS: collectingQueue(jobs),
		RL_UPLOAD: limiter('upload'),
		RL_PUBLISH: limiter('publish'),
		RL_AUTH: limiter('auth'),
		RL_ANON: limiter('anonymous'),
		DASHBOARD_ORIGIN,
		CONTENT_DOMAIN,
		MAINTENANCE_SECRET:
			platformEnv.MAINTENANCE_SECRET ?? 'adrive-route-test-maintenance',
		WORKOS_API_KEY: 'fake:route-tests',
		WORKOS_DEV_FAKE: 'true',
		WORKOS_CLIENT_ID: 'client_test',
		WORKOS_COOKIE_PASSWORD: 'route-test-cookie-password-of-32-characters!',
		WORKOS_WEBHOOK_SECRET: 'route-test-webhook',
		// Abuse controls default to their Null services; a test sets
		// URLSCAN_API_KEY to `fake:<verdict>` or ADMIN_USER_IDS on ctx.env.
		URLSCAN_API_KEY: '',
		CF_ACCOUNT_ID: '',
		CF_API_TOKEN: '',
		CF_ZONE_ID: '',
		ADMIN_USER_IDS: ''
	} as Env;
	const cookies = new TestCookieStore();

	const build = ({
		method = 'GET',
		path,
		body,
		headers = {},
		params = {},
		url = new URL(path, DASHBOARD_ORIGIN)
	}: EventInput): RequestEvent => {
		// Upload routes require Content-Length (quota checks); undici only
		// sets it for fixed-length bodies, so supply it for strings here.
		const withLength =
			typeof body !== 'string'
				? headers
				: {
						'content-length': String(new TextEncoder().encode(body).byteLength),
						...headers
					};
		const request = new Request(url, {
			method,
			headers: {
				origin: DASHBOARD_ORIGIN,
				...withLength
			},
			body: body ?? undefined,
			duplex: body instanceof ReadableStream ? 'half' : undefined
		} as RequestInit);
		const event = {
			cookies,
			getClientAddress: () => '127.0.0.1',
			params,
			platform: {
				env,
				ctx: {
					waitUntil: (promise: Promise<unknown>) => {
						waitUntilQueue.push(promise);
					},
					passThroughOnException: () => {}
				},
				caches: globalThis.caches,
				cf: undefined
			},
			request,
			url,
			isSubRequest: false,
			route: { id: null },
			setHeaders: () => {},
			isDataRequest: false,
			locals: { auth: null, content: null },
			fetch: globalThis.fetch
		} as unknown as RequestEvent;
		setRequestEvent(event);
		return event;
	};

	const buildContent = async (input: ContentEventInput) => {
		const { contentSlugFromHost } = await import('../host-gate');
		const { resolveContentHost } = await import('../content-host');
		const url =
			input.url ??
			new URL(input.path, contentOrigin(input.slug ?? 'missing-slug'));
		const slug = input.slug ?? contentSlugFromHost(url.host, CONTENT_DOMAIN);
		if (slug === null) throw new Error(`Not a content host: ${url.host}`);
		const resolved = await resolveContentHost(env, slug);
		if (resolved._tag !== 'Found') {
			// The hook answers 404 (unknown or suspended) or 301 (a released
			// slug) before any route runs; the redirect is surfaced the same
			// way so a test can assert on it.
			const { error, redirect } = await import('@sveltejs/kit');
			return resolved._tag === 'Missing'
				? error(404, 'Not found')
				: redirect(
						301,
						new URL(
							`${url.pathname}${url.search}`,
							contentOrigin(resolved.slug)
						).href
					);
		}
		const event = build({ ...input, url });
		event.locals.content = resolved.host;
		return event;
	};

	return {
		env,
		cookies,
		url: (path) => new URL(path, DASHBOARD_ORIGIN),
		event: build,
		contentEvent: buildContent,
		drainWaitUntil: async () => {
			await Promise.allSettled(waitUntilQueue.splice(0));
		},
		jobs,
		deniedRateLimits,
		drainJobs: async () => {
			const { handleJobBatch } = await import('../jobs/consumer');
			const decisions: Array<JobDecision> = [];
			const parked: Array<SentJob> = [];
			let id = 0;
			const attempts = new Map<string, number>();
			// A retry decision re-queues the same body with attempts + 1,
			// mirroring the queue; runaway retries are bounded like
			// max_retries so a broken handler fails the test instead of
			// spinning.
			while (jobs.length > 0) {
				const batch = jobs.splice(0).map((job) => {
					const key = JSON.stringify(job.body);
					const count = (attempts.get(key) ?? 0) + 1;
					attempts.set(key, count);
					if (count > 6) {
						throw new Error(`Job exceeded retries: ${key}`);
					}
					id += 1;
					return { id: `test-${id}`, attempts: count, body: job.body };
				});
				const batchDecisions = await handleJobBatch(env, {
					queue: 'adrive-jobs',
					messages: batch
				});
				decisions.push(...batchDecisions);
				for (const sent of jobs.splice(0)) {
					(sent.delaySeconds > 0 ? parked : jobs).push(sent);
				}
				for (const decision of batchDecisions) {
					if (!('retry' in decision)) continue;
					const message = batch.find((entry) => entry.id === decision.id);
					if (message) {
						jobs.push({
							body: message.body,
							delaySeconds: decision.delaySeconds
						});
					}
				}
			}
			jobs.push(...parked);
			return decisions;
		}
	};
};

export const mockGetRequestEvent = () => ({
	getRequestEvent: vi.fn(() => {
		if (!currentEvent) {
			throw new Error('No request event registered for this test');
		}
		return currentEvent;
	})
});
