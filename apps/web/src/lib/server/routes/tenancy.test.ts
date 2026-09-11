import { describe, expect, it, vi } from 'vitest';
import { FileContentLinkResponseSchema } from '@adrive/shared';
import { Effect, Schema } from 'effect';
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
	currentIdentity,
	indexFile,
	listFiles,
	loginAs,
	mutateFile,
	uploadFile
} from '../test/helpers';

const queryPg = async <A>(
	env: Env,
	query: (sql: PgSql['Service']) => Effect.Effect<A, unknown>
) => {
	const { runWorkerProgram } = await import('$lib/server/edge');
	const { PgSql } = await import('$lib/server/pg');
	return runWorkerProgram(env, Effect.flatMap(PgSql, query));
};

const ORG_A = { userId: 'user_tenant_a' };
const ORG_B = { userId: 'user_tenant_b' };

describe('tenancy (local platform)', () => {
	let shared: RouteTestContext | undefined;
	const setup = async () => (shared ??= await createRouteContext());

	it('keeps files, tags, and search inside the org that owns them', async () => {
		const ctx = await setup();
		await loginAs(ctx, ORG_A);
		const fileA = await uploadFile(ctx, {
			name: 'zebra-ledger.txt',
			content: 'zebra ledger for org a',
			tags: ['shared-name']
		});
		await indexFile(ctx, fileA.id);
		const listedA = await listFiles(ctx);
		expect(listedA.files.map((file) => file.id)).toContain(fileA.id);
		const tagA = listedA.tags.find((tag) => tag.name === 'shared-name');
		expect(tagA).toBeDefined();

		await loginAs(ctx, ORG_B);
		const listedB = await listFiles(ctx);
		expect(listedB.files.map((file) => file.id)).not.toContain(fileA.id);
		expect(listedB.tags.map((tag) => tag.id)).not.toContain(tagA?.id);

		// The other org's file is a 404 by id on every dashboard read.
		const { GET: detailGET } =
			await import('../../../routes/api/files/[id]/+server.js');
		await expect(
			call(
				detailGET,
				ctx.event({ path: `/api/files/${fileA.id}`, params: { id: fileA.id } })
			)
		).rejects.toMatchObject({ status: 404 });
		const { GET: linkGET } =
			await import('../../../routes/api/files/[id]/link/+server.js');
		await expect(
			call(
				linkGET,
				ctx.event({
					path: `/api/files/${fileA.id}/link`,
					params: { id: fileA.id }
				})
			)
		).rejects.toMatchObject({ status: 404 });
		const { PATCH } = await import('../../../routes/api/files/[id]/+server.js');
		await expect(
			call(
				PATCH,
				ctx.event({
					method: 'PATCH',
					path: `/api/files/${fileA.id}`,
					body: JSON.stringify({ action: 'trash' }),
					headers: { 'content-type': 'application/json' },
					params: { id: fileA.id }
				})
			)
		).rejects.toMatchObject({ status: 404 });

		// Same tag name lives independently in both orgs.
		const fileB = await uploadFile(ctx, {
			name: 'zebra-notes.txt',
			content: 'zebra notes for org b',
			tags: ['shared-name']
		});
		await indexFile(ctx, fileB.id);
		const listedBAfter = await listFiles(ctx);
		const tagB = listedBAfter.tags.find((tag) => tag.name === 'shared-name');
		expect(tagB).toBeDefined();
		expect(tagB?.id).not.toBe(tagA?.id);
		const tagRows = await queryPg(
			ctx.env,
			(sql) => sql<{ org_id: string }>`
				SELECT org_id FROM tags WHERE normalized_name = 'shared-name'
				ORDER BY org_id`
		);
		expect(tagRows).toHaveLength(2);

		// Search only returns this org's file even though both match.
		const { GET: searchGET } =
			await import('../../../routes/api/search/+server.js');
		const searched = (await (
			await call(searchGET, ctx.event({ path: '/api/search?q=zebra' }))
		).json()) as { files: ReadonlyArray<{ id: string }> };
		expect(searched.files.map((file) => file.id)).toEqual([fileB.id]);

		// A's tag id in B's filter matches nothing rather than leaking.
		const filtered = (await (
			await call(
				searchGET,
				ctx.event({ path: `/api/search?tag=${tagA?.id ?? ''}` })
			)
		).json()) as { files: ReadonlyArray<{ id: string }> };
		expect(filtered.files).toEqual([]);

		// B cannot rename or delete A's tag.
		const { DELETE: tagDELETE } =
			await import('../../../routes/api/tags/[id]/+server.js');
		await expect(
			call(
				tagDELETE,
				ctx.event({
					method: 'DELETE',
					path: `/api/tags/${tagA?.id ?? ''}`,
					params: { id: tagA?.id ?? '' }
				})
			)
		).rejects.toMatchObject({ status: 404 });

		// Public content still serves regardless of who asks, on A's host.
		const b = await currentIdentity(ctx);
		await loginAs(ctx, ORG_A);
		const a = await currentIdentity(ctx);
		const { GET: serveGET } = await import('../../../routes/f/[id]/+server.js');
		const served = await call(
			serveGET,
			await ctx.contentEvent({
				slug: a.orgSlug,
				path: `/f/${fileA.id}`,
				params: { id: fileA.id }
			})
		);
		expect(served.status).toBe(200);
		expect(await served.text()).toBe('zebra ledger for org a');

		// The same public file on B's host is a 404: the host names the org.
		await expect(
			call(
				serveGET,
				await ctx.contentEvent({
					slug: b.orgSlug,
					path: `/f/${fileA.id}`,
					params: { id: fileA.id }
				})
			)
		).rejects.toMatchObject({ status: 404 });
		const { GET: thumbnailGET } =
			await import('../../../routes/t/[id]/[version]/grid.webp/+server.js');
		await expect(
			call(
				thumbnailGET,
				await ctx.contentEvent({
					slug: b.orgSlug,
					path: `/t/${fileA.id}/1/grid.webp`,
					params: { id: fileA.id, version: '1' }
				})
			)
		).rejects.toMatchObject({ status: 404 });
	});

	it('answers 404 on every path for a host that names no live org', async () => {
		const ctx = await setup();
		await loginAs(ctx, ORG_A);
		const a = await currentIdentity(ctx);
		const file = await uploadFile(ctx, {
			name: 'hosted.txt',
			content: 'hosted'
		});
		const { resolveContentHost } = await import('$lib/server/content-host');

		// An unknown slug is refused by the hook before any route runs, and
		// the miss is remembered in KV.
		for (const path of [`/f/${file.id}`, '/f/anything', `/s/${file.id}/`]) {
			await expect(
				ctx.contentEvent({ slug: 'nobody-here', path })
			).rejects.toMatchObject({ status: 404 });
		}
		expect(await resolveContentHost(ctx.env, 'nobody-here')).toEqual({
			_tag: 'Missing'
		});
		expect(await ctx.env.AUTH_GUARD.get('org-slug:nobody-here')).toBe(
			JSON.stringify({ missing: true })
		);

		// The live org resolves and is cached with its trust.
		expect(await resolveContentHost(ctx.env, a.orgSlug)).toEqual({
			_tag: 'Found',
			host: { orgId: a.orgId, slug: a.orgSlug }
		});
		expect(await ctx.env.AUTH_GUARD.get(`org-slug:${a.orgSlug}`)).toBe(
			JSON.stringify({ orgId: a.orgId, trust: 'new' })
		);

		// Suspending the org takes its host offline once the cache entry is
		// dropped; the file itself is untouched.
		await queryPg(
			ctx.env,
			(sql) => sql`UPDATE orgs SET trust = 'suspended' WHERE id = ${a.orgId}`
		);
		await ctx.env.AUTH_GUARD.delete(`org-slug:${a.orgSlug}`);
		await expect(
			ctx.contentEvent({ slug: a.orgSlug, path: `/f/${file.id}` })
		).rejects.toMatchObject({ status: 404 });
		await queryPg(
			ctx.env,
			(sql) => sql`UPDATE orgs SET trust = 'new' WHERE id = ${a.orgId}`
		);
		await ctx.env.AUTH_GUARD.delete(`org-slug:${a.orgSlug}`);
		const { GET: serveGET } = await import('../../../routes/f/[id]/+server.js');
		const served = await call(
			serveGET,
			await ctx.contentEvent({
				slug: a.orgSlug,
				path: `/f/${file.id}`,
				params: { id: file.id }
			})
		);
		expect(served.status).toBe(200);
		expect(await served.text()).toBe('hosted');
	});

	it('meters stored bytes per org and enforces the plan limit', async () => {
		const ctx = await setup();
		const usage = async (orgId: string) =>
			(
				await queryPg(
					ctx.env,
					(sql) => sql<{ stored_bytes: number }>`
						SELECT stored_bytes FROM org_usage WHERE org_id = ${orgId}`
				)
			)[0]?.stored_bytes ?? -1;
		const setUsage = (orgId: string, bytes: number) =>
			queryPg(
				ctx.env,
				(sql) => sql`
					UPDATE org_usage SET stored_bytes = ${bytes} WHERE org_id = ${orgId}`
			);

		await loginAs(ctx, ORG_A);
		const a = await currentIdentity(ctx);
		const before = await usage(a.orgId);
		const file = await uploadFile(ctx, {
			name: 'metered.txt',
			content: '0123456789'
		});
		expect(await usage(a.orgId)).toBe(before + 10);

		// Fill A to within a few bytes of its plan: the next upload is
		// refused before any row or blob lands.
		const { planLimits } = await import('$lib/server/plans');
		await setUsage(a.orgId, planLimits('free').storedBytes - 5);
		const { PUT } = await import('../../../routes/api/files/+server.js');
		await expect(
			call(
				PUT,
				ctx.event({
					method: 'PUT',
					path: '/api/files',
					body: '0123456789',
					headers: {
						'content-type': 'text/plain',
						'x-adrive-file-name': 'too-big.txt'
					}
				})
			)
		).rejects.toMatchObject({ status: 413 });
		await setUsage(a.orgId, before + 10);

		// B's counter is its own.
		await loginAs(ctx, ORG_B);
		const b = await currentIdentity(ctx);
		const beforeB = await usage(b.orgId);
		await uploadFile(ctx, { name: 'metered-b.txt', content: '0123456789' });
		expect(await usage(b.orgId)).toBe(beforeB + 10);
		expect(await usage(a.orgId)).toBe(before + 10);

		// Purging hands the bytes back.
		await loginAs(ctx, ORG_A);
		await mutateFile(ctx, file.id, { action: 'trash' });
		await mutateFile(ctx, file.id, { action: 'purge' });
		await ctx.drainJobs();
		expect(await usage(a.orgId)).toBe(before);
	});

	it('binds a device-approved API key to the approving org', async () => {
		const ctx = await setup();
		const { POST: startPOST } =
			await import('../../../routes/api/auth/device/+server.js');
		const started = await call(
			startPOST,
			ctx.event({
				method: 'POST',
				path: '/api/auth/device',
				body: JSON.stringify({ name: 'tenancy cli' }),
				headers: { 'content-type': 'application/json' }
			})
		);
		expect(started.status).toBe(201);
		const device = (await started.json()) as {
			deviceCode: string;
			userCode: string;
		};

		await loginAs(ctx, ORG_A);
		const owner = await currentIdentity(ctx);
		const { POST: approvePOST } =
			await import('../../../routes/api/auth/device/approve/+server.js');
		const approved = await call(
			approvePOST,
			ctx.event({
				method: 'POST',
				path: '/api/auth/device/approve',
				body: JSON.stringify({ userCode: device.userCode }),
				headers: { 'content-type': 'application/json' }
			})
		);
		expect(approved.status).toBe(200);

		const { POST: tokenPOST } =
			await import('../../../routes/api/auth/device/token/+server.js');
		const polled = await call(
			tokenPOST,
			ctx.event({
				method: 'POST',
				path: '/api/auth/device/token',
				body: JSON.stringify({ deviceCode: device.deviceCode }),
				headers: { 'content-type': 'application/json' }
			})
		);
		expect(polled.status).toBe(200);
		const { apiKey } = (await polled.json()) as { apiKey: string };
		expect(apiKey).toMatch(/^adr_/);

		const keyRows = await queryPg(
			ctx.env,
			(sql) => sql<{ org_id: string; user_id: string }>`
				SELECT org_id, user_id FROM api_keys WHERE name = 'tenancy cli'`
		);
		expect(keyRows).toEqual([{ org_id: owner.orgId, user_id: owner.userId }]);

		// The bearer key acts as its org regardless of the cookie jar.
		await loginAs(ctx, ORG_B);
		const { GET: filesGET } =
			await import('../../../routes/api/files/+server.js');
		const asKey = await call(
			filesGET,
			ctx.event({
				path: '/api/files',
				headers: { authorization: `Bearer ${apiKey}` }
			})
		);
		expect(asKey.status).toBe(200);

		// Key inventory is per org: B never sees A's key.
		const { GET: keysGET } =
			await import('../../../routes/api/auth/keys/+server.js');
		const listedForB = (await (
			await call(keysGET, ctx.event({ path: '/api/auth/keys' }))
		).json()) as { keys: ReadonlyArray<{ name: string }> };
		expect(listedForB.keys.map((key) => key.name)).not.toContain('tenancy cli');

		await loginAs(ctx, ORG_A);
		const listedForA = (await (
			await call(keysGET, ctx.event({ path: '/api/auth/keys' }))
		).json()) as { keys: ReadonlyArray<{ name: string }> };
		expect(listedForA.keys.map((key) => key.name)).toContain('tenancy cli');
	});
});

describe('org slugs (local platform)', () => {
	let shared: RouteTestContext | undefined;
	const setup = async () => (shared ??= await createRouteContext());
	const OWNER = { userId: 'user_slug_owner' };

	const patchSlug = async (ctx: RouteTestContext, slug: string) => {
		const { PATCH } = await import('../../../routes/api/org/+server.js');
		return call(
			PATCH,
			ctx.event({
				method: 'PATCH',
				path: '/api/org',
				body: JSON.stringify({ slug }),
				headers: { 'content-type': 'application/json' }
			})
		);
	};

	it('serves an existing private link after following the old host redirect', async () => {
		const ctx = await setup();
		await loginAs(ctx, { userId: `user_grant_rename_${crypto.randomUUID()}` });
		const before = await currentIdentity(ctx);
		const file = await uploadFile(ctx, {
			name: 'private-moving.txt',
			content: 'private content after rename',
			isPublic: false
		});
		const { GET: linkGET } =
			await import('../../../routes/api/files/[id]/link/+server.js');
		const linked = await call(
			linkGET,
			ctx.event({
				path: `/api/files/${file.id}/link`,
				params: { id: file.id }
			})
		);
		const link = await Schema.decodeUnknownPromise(
			FileContentLinkResponseSchema
		)(await linked.json());
		expect(link.public).toBe(false);
		const oldUrl = new URL(link.url);
		expect(oldUrl.origin).toBe(`http://${before.orgSlug}.localhost:5174`);
		const { handle } = await import('../../../hooks.server.js');
		const { GET: serveGET } = await import('../../../routes/f/[id]/+server.js');
		const requestContent = (url: URL) =>
			handle({
				event: ctx.event({
					path: `${url.pathname}${url.search}`,
					url,
					params: { id: file.id }
				}),
				resolve: (event) => call(serveGET, event)
			});
		expect((await requestContent(oldUrl)).status).toBe(200);
		const next = `private-${crypto.randomUUID().slice(0, 8)}`;
		expect((await patchSlug(ctx, next)).status).toBe(200);
		const redirected = await requestContent(oldUrl);
		expect(redirected.status).toBe(301);
		const location = redirected.headers.get('location');
		expect(location).toBe(
			`http://${next}.localhost:5174${oldUrl.pathname}${oldUrl.search}`
		);
		if (!location) throw new Error('The renamed content host did not redirect');
		const served = await requestContent(new URL(location));
		expect(served.status).toBe(200);
		expect(await served.text()).toBe('private content after rename');
	});

	it('lets an owner rename the content host once per 30 days with redirects', async () => {
		const ctx = await setup();
		await loginAs(ctx, OWNER);
		const before = await currentIdentity(ctx);
		const file = await uploadFile(ctx, {
			name: 'moving.txt',
			content: 'moved'
		});
		const { resolveContentHost } = await import('$lib/server/content-host');
		// Warm the cache for the old slug so the change has to purge it.
		expect((await resolveContentHost(ctx.env, before.orgSlug))._tag).toBe(
			'Found'
		);

		const { GET } = await import('../../../routes/api/org/+server.js');
		const settings = (await (
			await call(GET, ctx.event({ path: '/api/org' }))
		).json()) as {
			slug: string;
			contentOrigin: string;
			nextSlugChangeAt: null;
		};
		expect(settings.slug).toBe(before.orgSlug);
		expect(settings.contentOrigin).toBe(
			`http://${before.orgSlug}.localhost:5174`
		);
		expect(settings.nextSlugChangeAt).toBeNull();

		for (const bad of ['ab', 'Has Space', '-lead', 'admin', 'x'.repeat(33)]) {
			await expect(patchSlug(ctx, bad)).rejects.toMatchObject({ status: 400 });
		}

		const next = `moved-${crypto.randomUUID().slice(0, 8)}`;
		const changed = (await (await patchSlug(ctx, next)).json()) as {
			slug: string;
			contentOrigin: string;
			nextSlugChangeAt: string | null;
		};
		expect(changed.slug).toBe(next);
		expect(changed.contentOrigin).toBe(`http://${next}.localhost:5174`);
		expect(changed.nextSlugChangeAt).not.toBeNull();

		// The session picks the new slug up on its next request, and links
		// are generated for the new host.
		const after = await currentIdentity(ctx);
		expect(after.orgSlug).toBe(next);
		const listed = await listFiles(ctx);
		expect(listed.contentOrigin).toBe(`http://${next}.localhost:5174`);

		// Old host redirects to the same path on the new one; the new host
		// serves the file; both cache entries were purged and re-resolved.
		expect(await resolveContentHost(ctx.env, before.orgSlug)).toEqual({
			_tag: 'Moved',
			slug: next
		});
		await expect(
			ctx.contentEvent({ slug: before.orgSlug, path: `/f/${file.id}?v=1` })
		).rejects.toMatchObject({
			status: 301,
			location: `http://${next}.localhost:5174/f/${file.id}?v=1`
		});
		const { GET: serveGET } = await import('../../../routes/f/[id]/+server.js');
		const served = await call(
			serveGET,
			await ctx.contentEvent({
				slug: next,
				path: `/f/${file.id}`,
				params: { id: file.id }
			})
		);
		expect(await served.text()).toBe('moved');

		// A second change inside the window is refused, and so is anyone
		// else claiming the parked slug while it still redirects.
		await expect(
			patchSlug(ctx, `again-${crypto.randomUUID().slice(0, 8)}`)
		).rejects.toMatchObject({ status: 409 });
		await loginAs(ctx, { userId: 'user_slug_other' });
		await expect(patchSlug(ctx, before.orgSlug)).rejects.toMatchObject({
			status: 409
		});
		await expect(patchSlug(ctx, next)).rejects.toMatchObject({ status: 409 });

		// A non-owner cannot rename at all.
		const other = await currentIdentity(ctx);
		// Session resolution mirrors the verified provider role, so change
		// that authority instead of a local membership it would overwrite.
		const { workOSFake } = await import('../services/workos');
		const memberSession = vi.spyOn(workOSFake, 'loadSession').mockReturnValue(
			Effect.succeed({
				authenticated: true,
				sessionId: `fake-session:${other.userId}`,
				userId: other.userId,
				orgId: other.orgId,
				role: 'member'
			})
		);
		try {
			await expect(
				patchSlug(ctx, `member-${crypto.randomUUID().slice(0, 8)}`)
			).rejects.toMatchObject({ status: 403 });
		} finally {
			memberSession.mockRestore();
		}
	});
});
