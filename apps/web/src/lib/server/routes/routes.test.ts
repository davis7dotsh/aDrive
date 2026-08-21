import { describe, expect, it, vi } from 'vitest';
import { Schema } from 'effect';
import { FileListResponseSchema } from '@adrive/shared';

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
