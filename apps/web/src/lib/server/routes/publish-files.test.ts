import { describe, expect, it, vi } from 'vitest';

vi.mock('$app/server', async () => {
	const { mockGetRequestEvent } = await import('../test/route-context.js');
	return mockGetRequestEvent();
});

import {
	call,
	createRouteContext,
	type RouteTestContext
} from '../test/route-context';
import { login, uploadFile } from '../test/helpers';

const publish = async (
	ctx: RouteTestContext,
	body: Record<string, unknown>
) => {
	const { POST } = await import('../../../routes/api/sites/publish/+server.js');
	const response = await call(
		POST,
		ctx.event({
			method: 'POST',
			path: '/api/sites/publish',
			body: JSON.stringify(body),
			headers: { 'content-type': 'application/json' }
		})
	);
	if (response.status !== 201) {
		throw new Error(
			`Publish failed: ${response.status} ${await response.text()}`
		);
	}
	await ctx.drainWaitUntil();
	return (await response.json()) as {
		file: { id: string };
		assetCount: number;
		url: string;
	};
};

const serveSite = async (ctx: RouteTestContext, id: string, path: string) => {
	const { GET } = await import('../../../routes/s/[id]/[...path]/+server.js');
	return call(
		GET,
		ctx.event({ path: `/s/${id}/${path}`, params: { id, path } })
	);
};

describe('publish drive files as a site (local platform)', () => {
	let shared: RouteTestContext | undefined;
	const setup = async () => (shared ??= await createRouteContext());

	it('generates a gallery when no index.html is selected', async () => {
		const ctx = await setup();
		await login(ctx);
		const photo = await uploadFile(ctx, {
			name: 'photo-a.png',
			content: 'AAA',
			contentType: 'image/png',
			isPublic: false
		});
		const notes = await uploadFile(ctx, {
			name: 'notes.txt',
			content: 'hello notes',
			contentType: 'text/plain',
			isPublic: false
		});

		const result = await publish(ctx, {
			fileIds: [photo.id, notes.id],
			displayName: 'my gallery'
		});
		// photo + notes + generated index.html
		expect(result.assetCount).toBe(3);

		const index = await serveSite(ctx, result.file.id, 'index.html');
		expect(index.status).toBe(200);
		expect(index.headers.get('content-type')).toContain('text/html');
		const html = await index.text();
		expect(html).toContain('photo-a.png');
		expect(html).toContain('notes.txt');

		const asset = await serveSite(ctx, result.file.id, 'photo-a.png');
		expect(asset.status).toBe(200);
		expect(asset.headers.get('content-type')).toContain('image/png');
		expect(await asset.text()).toBe('AAA');
	});

	it('uses an existing index.html when present in the selection', async () => {
		const ctx = await setup();
		await login(ctx);
		const index = await uploadFile(ctx, {
			name: 'index.html',
			content: '<h1>Custom home</h1>',
			contentType: 'text/html'
		});
		const style = await uploadFile(ctx, {
			name: 'style.css',
			content: 'body{color:#000}',
			contentType: 'text/css'
		});

		const result = await publish(ctx, {
			fileIds: [index.id, style.id],
			displayName: 'custom site'
		});
		// No generated index — exactly the two selected files.
		expect(result.assetCount).toBe(2);

		const home = await serveSite(ctx, result.file.id, 'index.html');
		expect(home.status).toBe(200);
		expect(await home.text()).toBe('<h1>Custom home</h1>');

		const css = await serveSite(ctx, result.file.id, 'style.css');
		expect(css.status).toBe(200);
		expect(await css.text()).toBe('body{color:#000}');
	});
});
