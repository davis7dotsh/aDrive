import { describe, expect, it, vi } from 'vitest';
import { Effect } from 'effect';
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

		// Public content still serves regardless of who asks.
		const { GET: serveGET } = await import('../../../routes/f/[id]/+server.js');
		const served = await call(
			serveGET,
			ctx.event({ path: `/f/${fileA.id}`, params: { id: fileA.id } })
		);
		expect(served.status).toBe(200);
		expect(await served.text()).toBe('zebra ledger for org a');
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
