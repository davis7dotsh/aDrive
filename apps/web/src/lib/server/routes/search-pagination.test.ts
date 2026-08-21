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

const seedPagedFiles = async (
	ctx: RouteTestContext,
	count: number,
	tag: string
) => {
	const ids: string[] = [];
	for (let i = 0; i < count; i += 1) {
		const file = await uploadFile(ctx, {
			name: `paged-orbit-${i}.txt`,
			content: `paged-orbit body ${i}`,
			isPublic: true,
			tags: [tag]
		});
		await indexFile(ctx, file.id);
		ids.push(file.id);
	}
	return ids;
};

describe('search pagination (local platform)', () => {
	let shared: RouteTestContext | undefined;
	let seededIds: string[] | undefined;
	const setup = async () => (shared ??= await createRouteContext());
	const ensureSeed = async (ctx: RouteTestContext) => {
		if (seededIds) return seededIds;
		await login(ctx);
		seededIds = await seedPagedFiles(ctx, 51, 'paged-orbit');
		return seededIds;
	};

	it('pages through ranked results with cursors and no overlap', async () => {
		const ctx = await setup();
		const ids = await ensureSeed(ctx);

		const { GET } = await import('../../../routes/api/search/+server.js');
		const first = await call(
			GET,
			ctx.event({ path: '/api/search?q=paged-orbit' })
		);
		expect(first.status).toBe(200);
		const page1 = await decodePage(first);
		expect(page1.files).toHaveLength(50);
		expect(page1.nextCursor).toBe('o:1');
		const firstIds = page1.files.map((file) => file.id);

		const again = await call(
			GET,
			ctx.event({ path: '/api/search?q=paged-orbit&cursor=o%3A1' })
		);
		expect(again.status).toBe(200);
		const page2 = await decodePage(again);
		expect(page2.files).toHaveLength(1);
		expect(page2.nextCursor).toBeNull();
		expect(firstIds).not.toContain(page2.files[0]?.id);
		expect([...firstIds, ...page2.files.map((file) => file.id)].sort()).toEqual(
			[...ids].sort()
		);
	});

	it('rejects malformed cursors with 400', async () => {
		const ctx = await setup();
		await login(ctx);
		const { GET } = await import('../../../routes/api/search/+server.js');
		await expect(
			call(GET, ctx.event({ path: '/api/search?q=x&cursor=zzz' }))
		).rejects.toMatchObject({ status: 400 });
		await expect(
			call(GET, ctx.event({ path: '/api/search?q=x&cursor=o%3A-1' }))
		).rejects.toMatchObject({ status: 400 });
	});

	it('paginates the no-query recent listing by tag id', async () => {
		const ctx = await setup();
		await ensureSeed(ctx);
		const listed = await import('../test/helpers').then((helpers) =>
			helpers.listFiles(ctx)
		);
		const tag = listed.tags.find((entry) => entry.name === 'paged-orbit');
		expect(tag).toBeDefined();

		const { GET } = await import('../../../routes/api/search/+server.js');
		const first = await call(
			GET,
			ctx.event({ path: `/api/search?tag=${tag!.id}` })
		);
		expect(first.status).toBe(200);
		const page1 = await decodePage(first);
		expect(page1.files).toHaveLength(50);
		expect(page1.nextCursor).toBe('o:1');

		const second = await call(
			GET,
			ctx.event({
				path: `/api/search?tag=${tag!.id}&cursor=${encodeURIComponent(page1.nextCursor!)}`
			})
		);
		expect(second.status).toBe(200);
		const page2 = await decodePage(second);
		expect(page2.files).toHaveLength(1);
		expect(page2.nextCursor).toBeNull();
		expect(page1.files.map((file) => file.id)).not.toContain(
			page2.files[0]?.id
		);
	});
});
