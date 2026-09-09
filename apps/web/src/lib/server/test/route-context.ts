import type { Cookies, RequestEvent } from '@sveltejs/kit';
import { vi } from 'vitest';

export const DASHBOARD_ORIGIN = 'http://localhost:5173';
// Content is served from `<slug>.<CONTENT_DOMAIN>`; browsers resolve
// `*.localhost` to loopback, which is also what the suite pins.
export const CONTENT_DOMAIN = 'localhost:5174';
export const contentOrigin = (slug: string) =>
	`http://${slug}.${CONTENT_DOMAIN}`;

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
}

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
	const env = {
		...platformEnv,
		DASHBOARD_ORIGIN,
		CONTENT_DOMAIN,
		MAINTENANCE_SECRET:
			platformEnv.MAINTENANCE_SECRET ?? 'adrive-route-test-maintenance',
		WORKOS_API_KEY: 'fake:route-tests',
		WORKOS_DEV_FAKE: 'true',
		WORKOS_CLIENT_ID: 'client_test',
		WORKOS_COOKIE_PASSWORD: 'route-test-cookie-password-of-32-characters!',
		WORKOS_WEBHOOK_SECRET: 'route-test-webhook'
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
