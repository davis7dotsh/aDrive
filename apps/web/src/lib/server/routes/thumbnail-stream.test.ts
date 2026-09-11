import { describe, expect, it, onTestFinished, vi } from 'vitest';
import { Effect } from 'effect';
import { dashboardThumbnailUrl } from '$lib/file-thumbnail';
import { PgSql } from '$lib/server/pg';
import { runWorkerProgram } from '$lib/server/edge';

vi.mock('$app/server', async () => {
	const { mockGetRequestEvent } = await import('../test/route-context.js');
	return mockGetRequestEvent();
});

import { call, createRouteContext } from '../test/route-context';
import { loginAs, uploadFile } from '../test/helpers';

describe('development thumbnail fallback', () => {
	it.each([
		{
			name: 'known source length',
			headers: new Headers({
				'content-type': 'image/gif',
				'content-length': '6'
			}),
			expectedLength: '6'
		},
		{
			name: 'unknown source length',
			headers: new Headers({ 'content-type': 'image/gif' }),
			expectedLength: null
		},
		{
			name: 'encoded source length',
			headers: new Headers({
				'content-type': 'image/gif',
				'content-length': '26',
				'content-encoding': 'gzip'
			}),
			expectedLength: null
		},
		{
			name: 'missing source type',
			headers: new Headers({ 'content-length': '6' }),
			expectedLength: '6'
		}
	])(
		'streams an authorized original with $name without caching it',
		async ({ headers, expectedLength }) => {
			const ctx = await createRouteContext();
			await loginAs(ctx, { userId: `user_thumb_${crypto.randomUUID()}` });
			const file = await uploadFile(ctx, {
				name: 'original.gif',
				content: 'GIF89a',
				contentType: 'image/gif',
				isPublic: false
			});
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
			const url = new URL(dashboardThumbnailUrl(link.url, file.id, 1));
			const { GET } =
				await import('../../../routes/t/[id]/[version]/grid.webp/+server.js');

			let pulls = 0;
			const source = new ReadableStream<Uint8Array>(
				{
					pull(controller) {
						pulls += 1;
						controller.enqueue(new TextEncoder().encode('GIF89a'));
						controller.close();
					}
				},
				{ highWaterMark: 0 }
			);
			const upstream = new Response(source, { headers });
			const originalFetch = globalThis.fetch;
			const sourceFetch = vi.fn(async () => upstream);
			const fetch = vi
				.spyOn(globalThis, 'fetch')
				.mockImplementation((input, init) => {
					const sourceUrl = new URL(
						input instanceof Request ? input.url : String(input)
					);
					return sourceUrl.origin === url.origin &&
						sourceUrl.pathname === `/f/${file.id}`
						? sourceFetch()
						: originalFetch(input, init);
				});
			onTestFinished(() => fetch.mockRestore());

			const unsigned = new URL(url);
			unsigned.search = '';
			await expect(
				call(
					GET,
					await ctx.contentEvent({
						url: unsigned,
						path: unsigned.pathname,
						params: { id: file.id, version: '1' }
					})
				)
			).rejects.toMatchObject({ status: 404 });
			expect(sourceFetch).not.toHaveBeenCalled();

			const response = await call(
				GET,
				await ctx.contentEvent({
					url,
					path: url.pathname + url.search,
					params: { id: file.id, version: '1' }
				})
			);
			expect(response.status).toBe(200);
			expect(sourceFetch).toHaveBeenCalledOnce();
			expect(pulls).toBe(0);
			expect(response.headers.get('content-type')).toBe('image/gif');
			expect(response.headers.get('content-length')).toBe(expectedLength);
			expect(response.headers.get('content-encoding')).toBeNull();
			expect(response.headers.get('cache-control')).toBe('private, no-store');
			expect(response.headers.get('content-security-policy')).toContain(
				"default-src 'none'"
			);
			expect(response.headers.get('x-content-type-options')).toBe('nosniff');
			expect(await response.text()).toBe('GIF89a');
			expect(pulls).toBe(1);
			await ctx.drainWaitUntil();
			const stored = await runWorkerProgram(
				ctx.env,
				Effect.flatMap(
					PgSql,
					(sql) => sql<{ thumbnail_r2_key: string | null }>`
				SELECT thumbnail_r2_key FROM file_versions
				WHERE file_id = ${file.id} AND version = 1`
				)
			);
			expect(stored).toEqual([{ thumbnail_r2_key: null }]);
		}
	);
});
