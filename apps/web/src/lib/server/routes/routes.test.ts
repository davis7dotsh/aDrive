import { describe, expect, it, onTestFinished, vi } from 'vitest';
import { Effect, Schema } from 'effect';
import { FileListResponseSchema } from '@adrive/shared';
import {
	dashboardRenderedThumbnailRequestPattern,
	dashboardThumbnailUrl
} from '$lib/file-thumbnail';
import type { PgSql } from '$lib/server/pg';

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
	currentContentOrigin,
	currentIdentity,
	login,
	uploadFile,
	listFiles,
	mutateFile,
	indexFile
} from '../test/helpers';

const SESSION_COOKIE = '__Host-adrive-wos';

// Files and versions live in Postgres now; read them through the request
// layer rather than the D1 binding.
const queryPg = async <A>(
	env: Env,
	query: (sql: PgSql['Service']) => Effect.Effect<A, unknown>
) => {
	const { runWorkerProgram } = await import('$lib/server/edge');
	const { PgSql } = await import('$lib/server/pg');
	return runWorkerProgram(env, Effect.flatMap(PgSql, query));
};

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
	onTestFinished(() => {
		Object.defineProperty(env, 'BROWSER', {
			value: original,
			configurable: true,
			writable: true
		});
	});
	return screenshot;
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

	it('signs in through the WorkOS callback and bootstraps a personal org', async () => {
		const ctx = await setup();
		const { GET: signInGET } =
			await import('../../../routes/auth/sign-in/+server.js');
		const started = await call(signInGET, ctx.event({ path: '/auth/sign-in' }));
		expect(started.status).toBe(302);
		expect(started.headers.get('location')).toContain('/auth/callback');

		const { GET: callbackGET } =
			await import('../../../routes/auth/callback/+server.js');
		await expect(
			call(
				callbackGET,
				ctx.event({ path: '/auth/callback?code=fake:user_test:&state=wrong' })
			)
		).rejects.toMatchObject({ status: 400 });

		await login(ctx);
		expect(ctx.cookies.get(SESSION_COOKIE)).toMatch(/^fake:user_test:org_/);
		const { GET } = await import('../../../routes/api/auth/check/+server.js');
		const checked = await call(GET, ctx.event({ path: '/api/auth/check' }));
		expect(checked.status).toBe(200);
		const tenant = await queryPg(
			ctx.env,
			(sql) => sql<{ org_id: string; role: string; stored: number }>`
				SELECT m.org_id, m.role, u.stored_bytes AS stored
				FROM memberships m JOIN org_usage u ON u.org_id = m.org_id
				WHERE m.user_id = 'user_test'`
		);
		expect(tenant).toHaveLength(1);
		expect(tenant[0]?.role).toBe('owner');
		expect(tenant[0]?.stored).toBeGreaterThanOrEqual(0);
	});

	it('uploads, lists, links, and serves bytes end to end', async () => {
		const ctx = await setup();
		await login(ctx);
		const file = await uploadFile(ctx, {
			name: 'hello-integration.txt',
			content: 'integration body',
			isPublic: true
		});
		await ctx.drainJobs();

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

		expect(link.url).toBe(`${await currentContentOrigin(ctx)}/f/${file.id}`);
		const { GET: serveGET } = await import('../../../routes/f/[id]/+server.js');
		const served = await call(
			serveGET,
			await ctx.contentEvent({
				url: new URL(link.url),
				path: `/f/${file.id}`,
				params: { id: file.id }
			})
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

		await mutateFile(ctx, file.id, { action: 'purge' });
		await ctx.drainJobs();

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
			file: { id: string; public: boolean };
			assetCount: number;
		};
		expect(commit.file.id).toBe(session.fileId);
		expect(commit.assetCount).toBe(2);
		await ctx.drainWaitUntil();
		// A verified org's site is held until the scanner clears it.
		expect(commit.file.public).toBe(false);
		await ctx.drainJobs();

		const { orgSlug } = await currentIdentity(ctx);
		const siteOrigin = await currentContentOrigin(ctx);
		const { GET: serveSiteGET } =
			await import('../../../routes/s/[id]/[...path]/+server.js');
		const page = await call(
			serveSiteGET,
			await ctx.contentEvent({
				slug: orgSlug,
				path: `/s/${session.fileId}/index.html`,
				params: { id: session.fileId, path: 'index.html' }
			})
		);
		expect(page.status).toBe(200);
		expect(page.headers.get('content-type')).toContain('text/html');
		expect(await page.text()).toBe('<h1>promo</h1>ok');

		const { GET: linkGET } =
			await import('../../../routes/api/files/[id]/link/+server.js');
		const publicLinkResponse = await call(
			linkGET,
			ctx.event({
				path: `/api/files/${session.fileId}/link`,
				params: { id: session.fileId }
			})
		);
		expect(await publicLinkResponse.json()).toMatchObject({
			url: `${siteOrigin}/s/${session.fileId}/`,
			expiresAt: null,
			public: true,
			version: 1
		});

		const { GET: contentGET } =
			await import('../../../routes/api/files/[id]/content/+server.js');
		const publicContentResponse = await call(
			contentGET,
			ctx.event({
				path: `/api/files/${session.fileId}/content`,
				params: { id: session.fileId }
			})
		);
		expect(publicContentResponse.status).toBe(307);
		expect(publicContentResponse.headers.get('location')).toBe(
			`${siteOrigin}/s/${session.fileId}/`
		);

		const screenshot = mockBrowserScreenshot(ctx.env, 'site-webp');
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
		expect(thumbnailUrl.origin).toBe(siteOrigin);
		const generated = await call(
			thumbnailGET,
			await ctx.contentEvent({
				url: thumbnailUrl,
				path: `${thumbnailUrl.pathname}${thumbnailUrl.search}`,
				params: { id: session.fileId, version: '1' }
			})
		);
		expect(generated.status).toBe(307);
		expect(screenshot).toHaveBeenCalledOnce();
		const [action, screenshotOptions] = screenshot.mock.calls[0] ?? [];
		expect(action).toBe('screenshot');
		expect(screenshotOptions).toMatchObject({
			viewport: { width: 1_200, height: 900 },
			screenshotOptions: { type: 'webp', quality: 75 },
			allowResourceTypes: ['document', 'stylesheet', 'image', 'font', 'script'],
			allowRequestPattern: [
				dashboardRenderedThumbnailRequestPattern(siteOrigin)
			]
		});
		expect(screenshotOptions && 'url' in screenshotOptions).toBe(true);
		const sourceUrl = new URL(
			screenshotOptions && 'url' in screenshotOptions
				? screenshotOptions.url
				: 'http://invalid.example'
		);
		expect(sourceUrl.pathname).toContain(`/s/${session.fileId}/@grant/1/`);
		expect(sourceUrl.searchParams.get('purpose')).toBe('thumbnail');
		expect(sourceUrl.searchParams.get('e')).not.toBeNull();
		expect(sourceUrl.searchParams.get('g')).not.toBeNull();
		const allowedScreenshotRequest = new RegExp(
			screenshotOptions?.allowRequestPattern?.[0] ?? '^$'
		);
		expect(allowedScreenshotRequest.test(sourceUrl.href)).toBe(true);
		expect(
			allowedScreenshotRequest.test(
				new URL(`/s/${session.fileId}/style.css`, siteOrigin).href
			)
		).toBe(true);
		expect(allowedScreenshotRequest.test('https://evil.example/steal')).toBe(
			false
		);
		expect(
			allowedScreenshotRequest.test('http://169.254.169.254/latest/meta-data/')
		).toBe(false);

		const downloadCount = async () =>
			(
				await queryPg(
					ctx.env,
					(sql) => sql<{ download_count: number }>`
						SELECT download_count FROM files WHERE id = ${session.fileId}`
				)
			)[0]?.download_count;
		const countBefore = await downloadCount();
		const screenshotSource = await call(
			serveSiteGET,
			await ctx.contentEvent({
				url: sourceUrl,
				path: `${sourceUrl.pathname}${sourceUrl.search}`,
				params: {
					id: session.fileId,
					path: sourceUrl.pathname.slice(`/s/${session.fileId}/`.length)
				}
			})
		);
		expect(screenshotSource.status).toBe(200);
		expect(await downloadCount()).toBe(countBefore);

		const forgedSource = new URL(link.url);
		forgedSource.searchParams.set('purpose', 'thumbnail');
		await expect(
			call(
				serveSiteGET,
				await ctx.contentEvent({
					url: forgedSource,
					path: `${forgedSource.pathname}${forgedSource.search}`,
					params: {
						id: session.fileId,
						path: forgedSource.pathname.slice(`/s/${session.fileId}/`.length)
					}
				})
			)
		).rejects.toMatchObject({ status: 404 });
		expect(await downloadCount()).toBe(countBefore);

		const cachedUrl = new URL(generated.headers.get('location') ?? '');
		const cached = await call(
			thumbnailGET,
			await ctx.contentEvent({
				url: cachedUrl,
				path: cachedUrl.pathname,
				params: { id: session.fileId, version: '1' }
			})
		);
		expect(cached.status).toBe(200);
		expect(cached.headers.get('content-type')).toBe('image/webp');
		expect(cached.headers.get('cache-control')).toContain('immutable');
		expect(await cached.text()).toBe('site-webp');
		expect(screenshot).toHaveBeenCalledOnce();
		const stored = (
			await queryPg(
				ctx.env,
				(sql) => sql<{ thumbnail_r2_key: string | null }>`
					SELECT thumbnail_r2_key FROM file_versions
					WHERE file_id = ${session.fileId} AND version = 1`
			)
		)[0];
		expect(stored?.thumbnail_r2_key).toContain(
			`thumbnail/${session.fileId}/1/`
		);
		await ctx.drainWaitUntil();
		await mutateFile(ctx, session.fileId, { action: 'trash' });
		await mutateFile(ctx, session.fileId, { action: 'purge' });
		await ctx.drainJobs();
		expect(
			stored?.thumbnail_r2_key
				? await ctx.env.BUCKET.head(stored.thumbnail_r2_key)
				: undefined
		).toBeNull();
	});

	it('screenshots HTML file previews without serving the original document', async () => {
		const ctx = await setup();
		await login(ctx);
		const file = await uploadFile(ctx, {
			name: 'dashboard-preview.html',
			content: '<h1>lightweight preview</h1>',
			contentType: 'text/html',
			isPublic: false
		});
		await ctx.drainJobs();
		expect(
			await queryPg(
				ctx.env,
				(sql) => sql<{ public: boolean }>`
					SELECT public FROM files WHERE id = ${file.id}`
			)
		).toEqual([{ public: true }]);
		const screenshot = mockBrowserScreenshot(ctx.env, 'html-webp');
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
		const response = await call(
			thumbnailGET,
			await ctx.contentEvent({
				url: thumbnailUrl,
				path: `${thumbnailUrl.pathname}${thumbnailUrl.search}`,
				params: { id: file.id, version: '1' }
			})
		);
		expect(response.status).toBe(307);
		const options = screenshot.mock.calls[0]?.[1];
		expect(options && 'url' in options).toBe(true);
		expect(options?.allowRequestPattern).toEqual([
			dashboardRenderedThumbnailRequestPattern(await currentContentOrigin(ctx))
		]);
		const source = new URL(
			options && 'url' in options ? options.url : 'http://invalid.example'
		);
		expect(source.pathname).toBe(`/f/${file.id}`);
		expect(source.searchParams.get('purpose')).toBe('thumbnail');
		const { GET: serveGET } = await import('../../../routes/f/[id]/+server.js');
		const renderedSource = await call(
			serveGET,
			await ctx.contentEvent({
				url: source,
				path: `${source.pathname}${source.search}`,
				params: { id: file.id }
			})
		);
		expect(renderedSource.headers.get('content-disposition')).toMatch(
			/^inline;/
		);
		expect(await renderedSource.text()).toBe('<h1>lightweight preview</h1>');
		expect(screenshot).toHaveBeenCalledOnce();
		await ctx.drainWaitUntil();
	});

	it('mirrors WorkOS webhook removals and rejects unsigned payloads', async () => {
		const ctx = await setup();
		await login(ctx);
		const { POST } =
			await import('../../../routes/api/webhooks/workos/+server.js');
		const deliver = (body: unknown, signed = true) =>
			call(
				POST,
				ctx.event({
					method: 'POST',
					path: '/api/webhooks/workos',
					body: JSON.stringify(body),
					headers: {
						'content-type': 'application/json',
						...(signed ? { 'workos-signature': 't=1, v1=fake' } : {})
					}
				})
			);
		await expect(
			deliver({ event: 'user.deleted' }, false)
		).rejects.toMatchObject({ status: 401 });
		const before = await queryPg(
			ctx.env,
			(sql) => sql<{ org_id: string }>`
				SELECT org_id FROM memberships WHERE user_id = 'user_test'`
		);
		expect(before).toHaveLength(1);
		const orgId = before[0]?.org_id ?? '';
		const removed = await deliver({
			event: 'organization_membership.deleted',
			data: { organizationId: orgId, userId: 'user_test' }
		});
		expect(removed.status).toBe(200);
		expect(
			await queryPg(
				ctx.env,
				(sql) => sql<{ org_id: string }>`
					SELECT org_id FROM memberships WHERE user_id = 'user_test'`
			)
		).toEqual([]);
		// The session survives in WorkOS but no longer maps to a membership,
		// so the dashboard treats it as signed out.
		const { GET } = await import('../../../routes/api/auth/check/+server.js');
		await expect(
			call(GET, ctx.event({ path: '/api/auth/check' }))
		).rejects.toMatchObject({ status: 401 });
		// Signing in again as the same user rejoins the same org: the
		// callback pins the org on the session and re-creates the membership.
		const { loginAs } = await import('../test/helpers');
		await loginAs(ctx, { userId: 'user_test', orgId });
		expect(
			await queryPg(
				ctx.env,
				(sql) => sql<{ org_id: string }>`
					SELECT org_id FROM memberships WHERE user_id = 'user_test'`
			)
		).toEqual([{ org_id: orgId }]);
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
