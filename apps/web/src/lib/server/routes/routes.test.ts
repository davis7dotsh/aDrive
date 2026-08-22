import { describe, expect, it, vi } from 'vitest';
import { Schema } from 'effect';
import { FileListResponseSchema } from '@adrive/shared';
import { dashboardThumbnailUrl } from '$lib/file-thumbnail';

vi.mock('$app/server', async () => {
	const { mockGetRequestEvent } = await import('../test/route-context.js');
	return mockGetRequestEvent();
});

import {
	call,
	createRouteContext,
	type RouteTestContext
} from '../test/route-context';
import {
	login,
	uploadFile,
	listFiles,
	mutateFile,
	indexFile
} from '../test/helpers';

const SESSION_COOKIE = '__Host-adrive-session';

const mockBrowserScreenshot = (env: Env, body: string) => {
	const original = env.BROWSER;
	const screenshot = vi.fn(
		async (_action: 'screenshot', _options: BrowserRunScreenshotOptions) =>
			new Response(body, { headers: { 'content-type': 'image/webp' } })
	);
	Object.defineProperty(env, 'BROWSER', {
		value: { quickAction: screenshot },
		configurable: true,
		writable: true
	});
	return {
		screenshot,
		restore: () => {
			Object.defineProperty(env, 'BROWSER', {
				value: original,
				configurable: true,
				writable: true
			});
		}
	};
};

describe('route integration (local platform)', () => {
	let shared: RouteTestContext | undefined;
	const setup = async () => (shared ??= await createRouteContext());

	it('rejects an unauthenticated listing', async () => {
		const ctx = await setup();
		const { GET } = await import('../../../routes/api/files/+server.js');
		// The handle hook converts SvelteKit HttpErrors to responses in
		// production; at the handler boundary the 401 surfaces as a throw.
		await expect(
			call(GET, ctx.event({ path: '/api/files' }))
		).rejects.toMatchObject({ status: 401 });
	});

	it('creates a session from the passcode', async () => {
		const ctx = await setup();
		const { POST } =
			await import('../../../routes/api/auth/session/+server.js');
		const response = await call(
			POST,
			ctx.event({
				method: 'POST',
				path: '/api/auth/session',
				body: JSON.stringify({ passcode: ctx.env.PASSCODE }),
				headers: { 'content-type': 'application/json' }
			})
		);
		expect(response.status).toBe(200);
		expect(ctx.cookies.get(SESSION_COOKIE)).toBeDefined();
	});

	it('uploads, lists, links, and serves bytes end to end', async () => {
		const ctx = await setup();
		await login(ctx);
		const file = await uploadFile(ctx, {
			name: 'hello-integration.txt',
			content: 'integration body',
			isPublic: true
		});

		const listed = await listFiles(ctx);
		expect(listed.files.map((entry) => entry.id)).toContain(file.id);

		const { GET: linkGET } =
			await import('../../../routes/api/files/[id]/link/+server.js');
		const linkResponse = await call(
			linkGET,
			ctx.event({
				path: `/api/files/${file.id}/link`,
				params: { id: file.id }
			})
		);
		expect(linkResponse.status).toBe(200);
		const link = (await linkResponse.json()) as {
			url: string;
			public: boolean;
			version: number;
		};
		expect(link.public).toBe(true);
		expect(link.version).toBe(file.version);

		const { GET: serveGET } = await import('../../../routes/f/[id]/+server.js');
		const served = await call(
			serveGET,
			ctx.event({ path: `/f/${file.id}`, params: { id: file.id } })
		);
		expect(served.status).toBe(200);
		expect(await served.text()).toBe('integration body');
	});

	it('trashes, purges, and drops the file from listings', async () => {
		const ctx = await setup();
		await login(ctx);
		const file = await uploadFile(ctx, { name: 'doomed.txt', isPublic: true });

		const mutation = await mutateFile(ctx, file.id, { action: 'trash' });
		expect(mutation.file.id).toBe(file.id);
		await ctx.drainWaitUntil();

		await mutateFile(ctx, file.id, { action: 'purge' });
		await ctx.drainWaitUntil();

		const listed = await listFiles(ctx);
		expect(listed.files.map((entry) => entry.id)).not.toContain(file.id);
	});

	it('indexes text content and finds it through search', async () => {
		const ctx = await setup();
		await login(ctx);
		const file = await uploadFile(ctx, {
			name: 'xylophone-notes.txt',
			content: 'the xylophone concerto rehearsal schedule',
			isPublic: true
		});
		await indexFile(ctx, file.id);

		const { GET } = await import('../../../routes/api/search/+server.js');
		const response = await call(
			GET,
			ctx.event({ path: '/api/search?q=xylophone' })
		);
		expect(response.status).toBe(200);
		const decoded = await Schema.decodeUnknownPromise(FileListResponseSchema)(
			await response.json()
		);
		expect(decoded.files.map((entry) => entry.id)).toContain(file.id);
		expect(decoded.nextCursor).toBeNull();
	});

	it('publishes a site through the session state machine and serves it', async () => {
		const ctx = await setup();
		await login(ctx);

		const manifest = {
			displayName: 'promo-site',
			assets: [
				{ path: 'index.html', sizeBytes: 16, contentType: 'text/html' },
				{ path: 'style.css', sizeBytes: 23, contentType: 'text/css' }
			]
		};
		const { POST: createPOST } =
			await import('../../../routes/api/sites/sessions/+server.js');
		const created = await call(
			createPOST,
			ctx.event({
				method: 'POST',
				path: '/api/sites/sessions',
				body: JSON.stringify(manifest),
				headers: { 'content-type': 'application/json' }
			})
		);
		expect(created.status).toBe(201);
		const session = (await created.json()) as {
			sessionId: string;
			fileId: string;
		};

		const { PUT: stagePUT } =
			await import('../../../routes/api/sites/sessions/[id]/assets/+server.js');
		const stageAsset = (path: string, body: string, contentType: string) =>
			call(
				stagePUT,
				ctx.event({
					method: 'PUT',
					path: `/api/sites/sessions/${session.sessionId}/assets?path=${path}`,
					body,
					headers: { 'content-type': contentType },
					params: { id: session.sessionId }
				})
			);
		expect(
			(await stageAsset('index.html', '<h1>promo</h1>ok', 'text/html')).status
		).toBe(201);
		expect(
			(await stageAsset('style.css', 'body{color:black}/*ok*/', 'text/css'))
				.status
		).toBe(201);

		const { POST: commitPOST } =
			await import('../../../routes/api/sites/sessions/[id]/commit/+server.js');
		const committed = await call(
			commitPOST,
			ctx.event({
				method: 'POST',
				path: `/api/sites/sessions/${session.sessionId}/commit`,
				params: { id: session.sessionId }
			})
		);
		expect(committed.status).toBe(201);
		const commit = (await committed.json()) as {
			file: { id: string };
			assetCount: number;
		};
		expect(commit.file.id).toBe(session.fileId);
		expect(commit.assetCount).toBe(2);
		await ctx.drainWaitUntil();

		const { GET: serveSiteGET } =
			await import('../../../routes/s/[id]/[...path]/+server.js');
		const page = await call(
			serveSiteGET,
			ctx.event({
				path: `/s/${session.fileId}/index.html`,
				params: { id: session.fileId, path: 'index.html' }
			})
		);
		expect(page.status).toBe(200);
		expect(page.headers.get('content-type')).toContain('text/html');
		expect(await page.text()).toBe('<h1>promo</h1>ok');

		const { screenshot, restore } = mockBrowserScreenshot(ctx.env, 'site-webp');
		const { GET: linkGET } =
			await import('../../../routes/api/files/[id]/link/+server.js');
		const linked = await call(
			linkGET,
			ctx.event({
				path: `/api/files/${session.fileId}/link?v=1&grant=true`,
				params: { id: session.fileId }
			})
		);
		const link = (await linked.json()) as { url: string };
		const thumbnailUrl = new URL(
			dashboardThumbnailUrl(link.url, session.fileId, 1)
		);
		const { GET: thumbnailGET } =
			await import('../../../routes/t/[id]/[version]/grid.webp/+server.js');
		const signedEvent = ctx.event({
			path: `${thumbnailUrl.pathname}${thumbnailUrl.search}`,
			params: { id: session.fileId, version: '1' }
		});
		const generated = await call(thumbnailGET, {
			...signedEvent,
			url: thumbnailUrl,
			request: new Request(thumbnailUrl)
		});
		expect(generated.status).toBe(307);
		expect(screenshot).toHaveBeenCalledOnce();
		const [action, screenshotOptions] = screenshot.mock.calls[0] ?? [];
		expect(action).toBe('screenshot');
		expect(screenshotOptions).toMatchObject({
			viewport: { width: 1_200, height: 900 },
			screenshotOptions: { type: 'webp', quality: 75 }
		});
		expect(screenshotOptions && 'url' in screenshotOptions).toBe(true);
		const sourceUrl = new URL(
			screenshotOptions && 'url' in screenshotOptions
				? screenshotOptions.url
				: 'http://invalid.example'
		);
		expect(sourceUrl.pathname).toContain(`/s/${session.fileId}/@grant/1/`);
		expect(sourceUrl.searchParams.get('purpose')).toBe('thumbnail');

		const downloadCount = async () =>
			(
				await ctx.env.DB.prepare(
					'SELECT download_count FROM files WHERE id = ?'
				)
					.bind(session.fileId)
					.first<{ download_count: number }>()
			)?.download_count;
		const countBefore = await downloadCount();
		const sourceEvent = ctx.event({
			path: `${sourceUrl.pathname}${sourceUrl.search}`,
			params: {
				id: session.fileId,
				path: sourceUrl.pathname.slice(`/s/${session.fileId}/`.length)
			}
		});
		const screenshotSource = await call(serveSiteGET, {
			...sourceEvent,
			url: sourceUrl,
			request: new Request(sourceUrl)
		});
		expect(screenshotSource.status).toBe(200);
		expect(await downloadCount()).toBe(countBefore);

		const cachedUrl = new URL(generated.headers.get('location') ?? '');
		const cachedEvent = ctx.event({
			path: cachedUrl.pathname,
			params: { id: session.fileId, version: '1' }
		});
		const cached = await call(thumbnailGET, {
			...cachedEvent,
			url: cachedUrl,
			request: new Request(cachedUrl)
		});
		expect(cached.status).toBe(200);
		expect(cached.headers.get('content-type')).toBe('image/webp');
		expect(cached.headers.get('cache-control')).toContain('immutable');
		expect(await cached.text()).toBe('site-webp');
		expect(screenshot).toHaveBeenCalledOnce();
		const stored = await ctx.env.DB.prepare(
			'SELECT thumbnail_r2_key FROM file_versions WHERE file_id = ? AND version = 1'
		)
			.bind(session.fileId)
			.first<{ thumbnail_r2_key: string }>();
		expect(stored?.thumbnail_r2_key).toContain(
			`thumbnail/${session.fileId}/1/`
		);
		await ctx.drainWaitUntil();
		await mutateFile(ctx, session.fileId, { action: 'trash' });
		await mutateFile(ctx, session.fileId, { action: 'purge' });
		await ctx.drainWaitUntil();
		expect(
			stored?.thumbnail_r2_key
				? await ctx.env.BUCKET.head(stored.thumbnail_r2_key)
				: undefined
		).toBeNull();
		restore();
	});

	it('screenshots HTML file previews without serving the original document', async () => {
		const ctx = await setup();
		await login(ctx);
		const file = await uploadFile(ctx, {
			name: 'dashboard-preview.html',
			content: '<h1>lightweight preview</h1>',
			contentType: 'text/html',
			isPublic: true
		});
		const { screenshot, restore } = mockBrowserScreenshot(ctx.env, 'html-webp');
		const { GET: linkGET } =
			await import('../../../routes/api/files/[id]/link/+server.js');
		const linked = await call(
			linkGET,
			ctx.event({
				path: `/api/files/${file.id}/link?v=1&grant=true`,
				params: { id: file.id }
			})
		);
		const link = (await linked.json()) as { url: string };
		const thumbnailUrl = new URL(dashboardThumbnailUrl(link.url, file.id, 1));
		const { GET: thumbnailGET } =
			await import('../../../routes/t/[id]/[version]/grid.webp/+server.js');
		const event = ctx.event({
			path: `${thumbnailUrl.pathname}${thumbnailUrl.search}`,
			params: { id: file.id, version: '1' }
		});
		const response = await call(thumbnailGET, {
			...event,
			url: thumbnailUrl,
			request: new Request(thumbnailUrl)
		});
		expect(response.status).toBe(307);
		const options = screenshot.mock.calls[0]?.[1];
		expect(options && 'url' in options).toBe(true);
		const source = new URL(
			options && 'url' in options ? options.url : 'http://invalid.example'
		);
		expect(source.pathname).toBe(`/f/${file.id}`);
		expect(source.searchParams.get('purpose')).toBe('thumbnail');
		expect(screenshot).toHaveBeenCalledOnce();
		restore();
		await ctx.drainWaitUntil();
	});

	it('rejects credentials on a foreign origin with 421', async () => {
		const ctx = await setup();
		await login(ctx);
		const { GET } = await import('../../../routes/api/files/+server.js');
		const foreignUrl = new URL('http://evil.example/api/files');
		const foreignEvent = ctx.event({ path: '/api/files' });
		await expect(
			call(GET, {
				...foreignEvent,
				url: foreignUrl,
				request: new Request(foreignUrl)
			})
		).rejects.toMatchObject({ status: 421 });
	});
});
