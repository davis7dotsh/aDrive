import { FileContentLinkResponseSchema } from '@adrive/shared';
import { Effect, Schema } from 'effect';
import { describe, expect, it, onTestFinished, vi } from 'vitest';
import { runWorkerProgram } from '../edge';
import { PgSql } from '../pg';
import { Blobs } from '../services/blobs';
import { Sites } from '../services/sites';
import { currentIdentity, loginAs } from '../test/helpers';
import { call, contentOrigin, createRouteContext } from '../test/route-context';

vi.mock('$app/server', async () => {
	const { mockGetRequestEvent } = await import('../test/route-context.js');
	return mockGetRequestEvent();
});

const assets = [
	{
		path: 'index.html',
		contentType: 'text/html',
		body: '<link rel="stylesheet" href="assets/style.css"><h1>Held preview</h1>'
	},
	{ path: 'assets/style.css', contentType: 'text/css', body: 'h1{color:green}' }
];

const setup = async () => {
	const ctx = await createRouteContext();
	await loginAs(ctx, { userId: `held-site-${crypto.randomUUID()}` });
	const identity = await currentIdentity(ctx);
	onTestFinished(() =>
		runWorkerProgram(
			ctx.env,
			Effect.gen(function* () {
				const sql = yield* PgSql;
				const blobs = yield* Blobs;
				const keys = yield* sql<{ r2_key: string }>`
					SELECT a.r2_key FROM site_assets a JOIN files f ON f.id = a.file_id
					WHERE f.org_id = ${identity.orgId}
					UNION
					SELECT a.r2_key FROM staged_site_assets a
					JOIN site_upload_sessions s ON s.id = a.session_id
					WHERE s.org_id = ${identity.orgId} AND a.r2_key IS NOT NULL
				`;
				yield* blobs.deleteMany(keys.map((row) => row.r2_key));
				yield* sql`DELETE FROM site_upload_sessions WHERE org_id = ${identity.orgId}`;
				yield* sql`DELETE FROM files WHERE org_id = ${identity.orgId}`;
				yield* sql`DELETE FROM orgs WHERE id = ${identity.orgId}`;
				yield* sql`DELETE FROM users WHERE id = ${identity.userId}`;
			})
		)
	);
	const publish = (fileId?: string) =>
		runWorkerProgram(
			ctx.env,
			Effect.gen(function* () {
				const sites = yield* Sites;
				const session = yield* sites.createSession({
					displayName: 'held-site',
					...(fileId ? { fileId } : {}),
					assets: assets.map(({ path, body, contentType }) => ({
						path,
						contentType,
						sizeBytes: new TextEncoder().encode(body).byteLength
					}))
				});
				for (const asset of assets) {
					yield* sites.stageAsset({
						sessionId: session.sessionId,
						path: asset.path,
						contentLength: String(
							new TextEncoder().encode(asset.body).byteLength
						),
						body: new Response(asset.body).body
					});
				}
				return yield* sites.commit(session.sessionId);
			}),
			identity
		);
	const committed = await publish();
	expect(committed.file.public).toBe(false);
	const fileId = committed.file.id;
	const { GET: linkGET } =
		await import('../../../routes/api/files/[id]/link/+server.js');
	const link = async () => {
		const response = await call(
			linkGET,
			ctx.event({
				path: `/api/files/${fileId}/link`,
				params: { id: fileId }
			})
		);
		expect(response.status).toBe(200);
		return Schema.decodeUnknownPromise(FileContentLinkResponseSchema)(
			await response.json()
		);
	};
	const { GET, HEAD } =
		await import('../../../routes/s/[id]/[...path]/+server.js');
	const serve = async (url: URL, method: 'GET' | 'HEAD' = 'GET') =>
		call(
			method === 'HEAD' ? HEAD : GET,
			await ctx.contentEvent({
				url,
				path: url.pathname + url.search,
				method,
				params: { id: fileId, path: url.pathname.slice(`/s/${fileId}/`.length) }
			})
		);
	return { ctx, identity, fileId, publish, link, serve };
};

describe('held site owner previews', () => {
	it('mints a private grant and serves relative assets without publishing the site', async () => {
		const { ctx, identity, fileId, link, serve } = await setup();
		const granted = await link();
		expect(granted.public).toBe(false);
		expect(granted.expiresAt).not.toBeNull();
		const root = new URL(granted.url);
		expect(root.pathname).toContain(`/s/${fileId}/@grant/1/`);
		const page = await serve(root);
		expect(page.status).toBe(200);
		expect(page.headers.get('cache-control')).toBe('private, no-store');
		expect(await page.text()).toBe(assets[0]?.body);
		const stylesheet = await serve(new URL('assets/style.css', root));
		expect(stylesheet.status).toBe(200);
		expect(await stylesheet.text()).toBe(assets[1]?.body);
		const head = await serve(root, 'HEAD');
		expect(head.status).toBe(200);
		expect(await head.text()).toBe('');
		for (const path of ['', 'assets/style.css']) {
			await expect(
				serve(new URL(`/s/${fileId}/${path}`, contentOrigin(identity.orgSlug)))
			).rejects.toMatchObject({ status: 404 });
		}
		const state = await runWorkerProgram(
			ctx.env,
			Effect.flatMap(
				PgSql,
				(sql) =>
					sql<{
						public: boolean;
						publish_pending: boolean;
					}>`SELECT public, publish_pending FROM files WHERE id = ${fileId}`
			)
		);
		expect(state[0]).toMatchObject({ public: false, publish_pending: true });
	});

	it('rejects forged, foreign, stale, and quarantined owner grants', async () => {
		const { ctx, identity, fileId, publish, link, serve } = await setup();
		const root = new URL((await link()).url);
		const parts = root.pathname.split('/');
		// /s/<id>/@grant/<version>/<expiry>/<signature>/
		const changedSignature = new URL(root);
		const signature = parts[6] ?? '';
		parts[6] = `${signature.startsWith('A') ? 'B' : 'A'}${signature.slice(1)}`;
		changedSignature.pathname = parts.join('/');
		const expired = new URL(root);
		const expiredParts = root.pathname.split('/');
		expiredParts[5] = '1';
		expired.pathname = expiredParts.join('/');
		const malformed = new URL(`/s/${fileId}/@grant/not-a-version/`, root);
		for (const denied of [changedSignature, expired, malformed]) {
			await expect(serve(denied)).rejects.toMatchObject({ status: 404 });
		}

		const foreign = await createRouteContext();
		await loginAs(foreign, { userId: `held-foreign-${crypto.randomUUID()}` });
		const foreignIdentity = await currentIdentity(foreign);
		onTestFinished(() =>
			runWorkerProgram(
				ctx.env,
				Effect.flatMap(PgSql, (sql) =>
					sql`DELETE FROM orgs WHERE id = ${foreignIdentity.orgId}`.pipe(
						Effect.andThen(
							sql`DELETE FROM users WHERE id = ${foreignIdentity.userId}`
						),
						Effect.asVoid
					)
				)
			)
		);
		const foreignHost = new URL(
			root.pathname,
			contentOrigin(foreignIdentity.orgSlug)
		);
		await expect(serve(foreignHost)).rejects.toMatchObject({ status: 404 });
		const { GET: linkGET } =
			await import('../../../routes/api/files/[id]/link/+server.js');
		await expect(
			call(
				linkGET,
				foreign.event({
					path: `/api/files/${fileId}/link`,
					params: { id: fileId }
				})
			)
		).rejects.toMatchObject({ status: 404 });

		await publish(fileId);
		await expect(serve(root)).rejects.toMatchObject({ status: 404 });
		const replacement = new URL((await link()).url);
		expect(replacement.pathname).toContain(`/@grant/2/`);
		expect((await serve(replacement)).status).toBe(200);
		await runWorkerProgram(
			ctx.env,
			Effect.flatMap(
				PgSql,
				(sql) =>
					sql`UPDATE files SET quarantined = true WHERE id = ${fileId} AND org_id = ${identity.orgId}`
			)
		);
		await expect(serve(replacement)).rejects.toMatchObject({ status: 404 });
		await expect(link()).rejects.toMatchObject({ status: 404 });
	});
});
