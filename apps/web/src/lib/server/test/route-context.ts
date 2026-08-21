import type { Cookies, RequestEvent } from '@sveltejs/kit';
import { vi } from 'vitest';

export const DASHBOARD_ORIGIN = 'http://localhost:5173';

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
	readonly event: (input: {
		method?: string;
		path: string;
		body?: BodyInit | null;
		headers?: Record<string, string>;
		params?: Record<string, string>;
	}) => RequestEvent;
	readonly drainWaitUntil: () => Promise<void>;
}

// SvelteKit types RequestEvent per route with phantom params, which a
// generic test event can never satisfy; the runtime shape is what matters,
// so this is the single sanctioned cast point.
export const call = async <E, R>(
	handler: (event: E) => R,
	event: RequestEvent
): Promise<R extends Promise<infer A> ? A : R> =>
	(handler as (event: RequestEvent) => R)(event) as Promise<
		R extends Promise<infer A> ? A : R
	>;

export const createRouteContext = async (): Promise<RouteTestContext> => {
	const { getTestPlatform } = await import('./platform');
	const proxy = await getTestPlatform();
	const env = proxy.env as unknown as Env;
	const cookies = new TestCookieStore();

	const build = ({
		method = 'GET',
		path,
		body,
		headers = {},
		params = {}
	}: {
		method?: string;
		path: string;
		body?: BodyInit | null;
		headers?: Record<string, string>;
		params?: Record<string, string>;
	}): RequestEvent => {
		const url = new URL(path, DASHBOARD_ORIGIN);
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
			locals: {},
			fetch: globalThis.fetch
		} as unknown as RequestEvent;
		setRequestEvent(event);
		return event;
	};

	return {
		env,
		cookies,
		url: (path) => new URL(path, DASHBOARD_ORIGIN),
		event: build,
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
