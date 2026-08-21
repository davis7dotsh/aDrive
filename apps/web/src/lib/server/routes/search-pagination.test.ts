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
import { login, uploadFile, indexFile } from '../test/helpers';

const decodePage = async (response: Response) =>
	Schema.decodeUnknownPromise(FileListResponseSchema)(await response.json());

describe('search pagination (local platform)', () => {
	let shared: RouteTestContext | undefined;
	const setup = async () => (shared ??= await createRouteContext());

	it('pages through ranked results with cursors and no overlap', async () => {
		const ctx = await setup();
		await login(ctx);
		const ids: string[] = [];
		for (let i = 0; i < 3; i += 1) {
			const file = await uploadFile(ctx, {
				name: `paginated-${i}.txt`,
				content: `paginated body ${i}`,
				isPublic: true
			});
			ids.push(file.id);
		}

		const { GET } = await import('../../../routes/api/search/+server.js');
		const first = await call(
			GET,
			ctx.event({ path: '/api/search?q=paginated' })
		);
		expect(first.status).toBe(200);
		const page1 = await decodePage(first);
		expect(page1.files.map((f) => f.id).sort()).toEqual([...ids].sort());
		// Fewer matches than one page: no cursor.
		expect(page1.nextCursor).toBeNull();

		// A beyond-the-end page cursor is valid and yields an empty page.
		const again = await call(
			GET,
			ctx.event({ path: '/api/search?q=paginated&cursor=o%3A1' })
		);
		expect(again.status).toBe(200);
		const page2 = await decodePage(again);
		expect(page2.files).toEqual([]);
		expect(page2.nextCursor).toBeNull();
	});

	it('rejects malformed cursors with 400', async () => {
		const ctx = await setup();
		await login(ctx);
		const { GET } = await import('../../../routes/api/search/+server.js');
		await expect(
			call(GET, ctx.event({ path: '/api/search?q=x&cursor=zzz' }))
		).rejects.toMatchObject({ status: 400 });
	});

	it('paginates the no-query recent listing by tag id', async () => {
		const ctx = await setup();
		await login(ctx);
		const file = await uploadFile(ctx, {
			name: 'recent-tagged.txt',
			isPublic: true,
			tags: ['recent-page']
		});
		await indexFile(ctx, file.id);

		// Resolve the created tag's id from the listing payload.
		const listed = await import('../test/helpers').then((h) =>
			h.listFiles(ctx)
		);
		const tag = listed.tags.find((t) => t.name === 'recent-page');
		expect(tag).toBeDefined();

		const { GET } = await import('../../../routes/api/search/+server.js');
		const first = await call(
			GET,
			ctx.event({ path: `/api/search?tag=${tag!.id}` })
		);
		expect(first.status).toBe(200);
		const page1 = await decodePage(first);
		expect(page1.files.map((f) => f.id)).toContain(file.id);

		const second = await call(
			GET,
			ctx.event({
				path: `/api/search?tag=${tag!.id}${
					page1.nextCursor
						? `&cursor=${encodeURIComponent(page1.nextCursor)}`
						: ''
				}`
			})
		);
		expect(second.status).toBe(200);
	});
});
