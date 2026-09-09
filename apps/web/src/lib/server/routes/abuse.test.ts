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

const setTrust = (env: Env, orgId: string, trust: string) =>
	queryPg(
		env,
		(sql) => sql`UPDATE orgs SET trust = ${trust} WHERE id = ${orgId}`
	);

describe('rate limits (local platform)', () => {
	let shared: RouteTestContext | undefined;
	const setup = async () => {
		shared ??= await createRouteContext();
		shared.deniedRateLimits.clear();
		return shared;
	};

	it('refuses uploads, device auth, and anonymous fetches once their limit is hit', async () => {
		const ctx = await setup();
		await loginAs(ctx, { userId: 'user_rate_limited' });
		const file = await uploadFile(ctx, { name: 'limited.txt' });

		ctx.deniedRateLimits.add('upload');
		const { PUT } = await import('../../../routes/api/files/+server.js');
		const refused = await call(
			PUT,
			ctx.event({
				method: 'PUT',
				path: '/api/files',
				body: 'more',
				headers: {
					'content-type': 'text/plain',
					'x-adrive-file-name': 'more.txt'
				}
			})
		);
		expect(refused.status).toBe(429);
		expect(refused.headers.get('retry-after')).toBe('60');
		const { POST: createSession } =
			await import('../../../routes/api/sites/sessions/+server.js');
		expect(
			(
				await call(
					createSession,
					ctx.event({
						method: 'POST',
						path: '/api/sites/sessions',
						body: JSON.stringify({ displayName: 'x', assets: [] }),
						headers: { 'content-type': 'application/json' }
					})
				)
			).status
		).toBe(429);
		ctx.deniedRateLimits.delete('upload');
		await uploadFile(ctx, { name: 'allowed-again.txt' });

		ctx.deniedRateLimits.add('auth');
		const { POST: devicePOST } =
			await import('../../../routes/api/auth/device/+server.js');
		expect(
			(
				await call(
					devicePOST,
					ctx.event({
						method: 'POST',
						path: '/api/auth/device',
						body: JSON.stringify({ name: 'cli' }),
						headers: { 'content-type': 'application/json' }
					})
				)
			).status
		).toBe(429);
		ctx.deniedRateLimits.delete('auth');

		// Anonymous fetches are counted only past the edge cache; a small
		// public file is served from R2 here, so the miss is refused.
		const { orgSlug } = await currentIdentity(ctx);
		const { GET: serveGET } = await import('../../../routes/f/[id]/+server.js');
		ctx.deniedRateLimits.add('anonymous');
		const denied = await call(
			serveGET,
			await ctx.contentEvent({
				slug: orgSlug,
				path: `/f/${file.id}`,
				params: { id: file.id }
			})
		);
		expect(denied.status).toBe(429);
		ctx.deniedRateLimits.delete('anonymous');
		const served = await call(
			serveGET,
			await ctx.contentEvent({
				slug: orgSlug,
				path: `/f/${file.id}`,
				params: { id: file.id }
			})
		);
		expect(served.status).toBe(200);
	});
});

describe('trust levels (local platform)', () => {
	let shared: RouteTestContext | undefined;
	const setup = async () => (shared ??= await createRouteContext());

	it('verifies the org on sign-in and keeps a new org private', async () => {
		const ctx = await setup();
		await loginAs(ctx, { userId: 'user_trust_new' });
		const { orgId } = await currentIdentity(ctx);
		const trustOf = async () =>
			(
				await queryPg(
					ctx.env,
					(sql) => sql<{ trust: string }>`
						SELECT trust FROM orgs WHERE id = ${orgId}`
				)
			)[0]?.trust;
		// The fake WorkOS signs in with a verified email.
		expect(await trustOf()).toBe('verified');
		const privateFile = await uploadFile(ctx, {
			name: 'private.txt',
			isPublic: false
		});

		await setTrust(ctx.env, orgId, 'new');
		const { PUT } = await import('../../../routes/api/files/+server.js');
		const upload = (name: string, isPublic: boolean) =>
			call(
				PUT,
				ctx.event({
					method: 'PUT',
					path: '/api/files',
					body: 'hello',
					headers: {
						'content-type': 'text/plain',
						'x-adrive-file-name': name,
						'x-adrive-public': String(isPublic)
					}
				})
			);
		await expect(upload('shared.txt', true)).rejects.toMatchObject({
			status: 403,
			body: { message: 'Verify your email to share publicly' }
		});
		// HTML is forced public, so it is refused even when asked private.
		await expect(upload('page.html', false)).rejects.toMatchObject({
			status: 403
		});
		expect((await upload('kept.txt', false)).status).toBe(201);
		await expect(
			mutateFile(ctx, privateFile.id, { action: 'visibility', public: true })
		).rejects.toMatchObject({ status: 403 });
		const { POST: createSession } =
			await import('../../../routes/api/sites/sessions/+server.js');
		await expect(
			call(
				createSession,
				ctx.event({
					method: 'POST',
					path: '/api/sites/sessions',
					body: JSON.stringify({
						displayName: 'site',
						assets: [
							{ path: 'index.html', sizeBytes: 2, contentType: 'text/html' }
						]
					}),
					headers: { 'content-type': 'application/json' }
				})
			)
		).rejects.toMatchObject({ status: 403 });

		// Signing in again with a verified email unlocks it.
		await loginAs(ctx, { userId: 'user_trust_new', orgId });
		expect(await trustOf()).toBe('verified');
		expect((await upload('shared.txt', true)).status).toBe(201);
	});

	it('promotes paid verified orgs to established after 14 days', async () => {
		const ctx = await setup();
		await loginAs(ctx, { userId: 'user_trust_paid' });
		const { orgId } = await currentIdentity(ctx);
		const { promoteEstablished } = await import('$lib/server/trust');
		const sweep = () =>
			queryPg(ctx.env, (sql) => promoteEstablished(sql, new Date()));
		const trustOf = async () =>
			(
				await queryPg(
					ctx.env,
					(sql) => sql<{ trust: string }>`
						SELECT trust FROM orgs WHERE id = ${orgId}`
				)
			)[0]?.trust;

		await queryPg(
			ctx.env,
			(sql) => sql`
				UPDATE orgs SET created_at = now() - interval '15 days'
				WHERE id = ${orgId}`
		);
		await sweep();
		expect(await trustOf()).toBe('verified');
		await queryPg(
			ctx.env,
			(sql) => sql`UPDATE orgs SET plan = 'pro' WHERE id = ${orgId}`
		);
		await sweep();
		expect(await trustOf()).toBe('established');
	});
});

describe('scan pipeline (local platform)', () => {
	let shared: RouteTestContext | undefined;
	const setup = async () => {
		shared ??= await createRouteContext();
		shared.jobs.splice(0);
		shared.env.URLSCAN_API_KEY = '';
		return shared;
	};

	const fileRow = (ctx: RouteTestContext, id: string) =>
		queryPg(
			ctx.env,
			(sql) => sql<{
				public: boolean;
				publish_pending: boolean;
				quarantined: boolean;
			}>`
				SELECT public, publish_pending, quarantined FROM files WHERE id = ${id}`
		).then((rows) => rows[0]);
	const verdicts = (ctx: RouteTestContext, id: string) =>
		queryPg(
			ctx.env,
			(sql) => sql<{ source: string; verdict: string }>`
				SELECT source, verdict FROM scan_verdicts
				WHERE file_id = ${id} ORDER BY source`
		);
	const notifications = (ctx: RouteTestContext, id: string) =>
		queryPg(
			ctx.env,
			(sql) => sql<{ kind: string }>`
				SELECT kind FROM notifications WHERE file_id = ${id} ORDER BY created_at`
		).then((rows) => rows.map((row) => row.kind));
	const serve = async (ctx: RouteTestContext, id: string) => {
		const { orgSlug } = await currentIdentity(ctx);
		const { GET } = await import('../../../routes/f/[id]/+server.js');
		return call(
			GET,
			await ctx.contentEvent({
				slug: orgSlug,
				path: `/f/${id}`,
				params: { id }
			})
		);
	};

	it('holds a verified publish until the scan clears it', async () => {
		const ctx = await setup();
		await loginAs(ctx, { userId: 'user_scan_hold' });
		const { orgId } = await currentIdentity(ctx);
		const file = await uploadFile(ctx, {
			name: 'held.txt',
			content: 'nothing to see',
			isPublic: false
		});
		ctx.jobs.splice(0);
		const result = await mutateFile(ctx, file.id, {
			action: 'visibility',
			public: true
		});
		expect(result.file).toMatchObject({ public: false });
		expect(await fileRow(ctx, file.id)).toEqual({
			public: false,
			publish_pending: true,
			quarantined: false
		});
		await expect(serve(ctx, file.id)).rejects.toMatchObject({ status: 404 });
		expect(ctx.jobs.map((job) => job.body)).toEqual([
			{ kind: 'scan', orgId, fileId: file.id, version: 1 }
		]);

		await ctx.drainJobs();
		expect(await fileRow(ctx, file.id)).toEqual({
			public: true,
			publish_pending: false,
			quarantined: false
		});
		expect(await verdicts(ctx, file.id)).toEqual([
			{ source: 'hash', verdict: 'clean' },
			{ source: 'sniff', verdict: 'clean' },
			{ source: 'urlscan', verdict: 'clean' }
		]);
		expect(await notifications(ctx, file.id)).toEqual(['published']);
		expect((await serve(ctx, file.id)).status).toBe(200);

		// An established org publishes at once and is scanned after.
		await setTrust(ctx.env, orgId, 'established');
		const quick = await uploadFile(ctx, {
			name: 'quick.txt',
			content: 'fine',
			isPublic: false
		});
		ctx.jobs.splice(0);
		await mutateFile(ctx, quick.id, { action: 'visibility', public: true });
		expect(await fileRow(ctx, quick.id)).toMatchObject({
			public: true,
			publish_pending: false
		});
		expect(ctx.jobs.map((job) => job.body.kind)).toEqual(['scan']);
	});

	it('quarantines a page whose links the URL scanner calls malicious', async () => {
		const ctx = await setup();
		await loginAs(ctx, { userId: 'user_scan_links' });
		const { orgId } = await currentIdentity(ctx);
		await setTrust(ctx.env, orgId, 'established');
		ctx.env.URLSCAN_API_KEY = 'fake:malicious';
		const file = await uploadFile(ctx, {
			name: 'phish.html',
			content:
				'<html><body><a href="https://evil.example/login">sign in</a></body></html>',
			contentType: 'text/html'
		});
		expect((await serve(ctx, file.id)).status).toBe(200);

		// First run submits the link and re-sends itself to poll; the poll
		// is delayed, so it runs on the next drain.
		await ctx.drainJobs();
		expect(ctx.jobs.map((job) => job.body)).toMatchObject([
			{
				kind: 'scan',
				fileId: file.id,
				version: 1,
				urlScan: { ids: ['fake-scan:https://evil.example/login'], attempt: 1 }
			}
		]);
		expect(await fileRow(ctx, file.id)).toMatchObject({ quarantined: false });
		await ctx.drainJobs();
		expect(await fileRow(ctx, file.id)).toEqual({
			public: false,
			publish_pending: false,
			quarantined: true
		});
		expect(await verdicts(ctx, file.id)).toEqual([
			{ source: 'hash', verdict: 'clean' },
			{ source: 'sniff', verdict: 'clean' },
			{ source: 'urlscan', verdict: 'malicious' }
		]);
		expect(await notifications(ctx, file.id)).toEqual(['quarantined']);
		await expect(serve(ctx, file.id)).rejects.toMatchObject({ status: 404 });
		// The owner cannot simply flip it back on.
		await expect(
			mutateFile(ctx, file.id, { action: 'visibility', public: true })
		).rejects.toMatchObject({ status: 403 });
	});

	it('quarantines a known-bad hash and flags active content under a benign type', async () => {
		const ctx = await setup();
		await loginAs(ctx, { userId: 'user_scan_hash' });
		const { orgId } = await currentIdentity(ctx);
		await setTrust(ctx.env, orgId, 'established');
		const payload = `malware sample ${crypto.randomUUID()}`;
		const sha256 = Array.from(
			new Uint8Array(
				await crypto.subtle.digest('SHA-256', new TextEncoder().encode(payload))
			),
			(byte) => byte.toString(16).padStart(2, '0')
		).join('');
		await queryPg(
			ctx.env,
			(sql) => sql`
				INSERT INTO blocked_hashes (sha256, reason) VALUES (${sha256}, 'test')`
		);
		const bad = await uploadFile(ctx, { name: 'sample.bin', content: payload });
		await ctx.drainJobs();
		expect(await fileRow(ctx, bad.id)).toMatchObject({
			public: false,
			quarantined: true
		});
		expect(await verdicts(ctx, bad.id)).toContainEqual({
			source: 'hash',
			verdict: 'malicious'
		});
		expect(
			(
				await queryPg(
					ctx.env,
					(sql) => sql<{ sha256: string | null }>`
						SELECT sha256 FROM file_versions WHERE file_id = ${bad.id}`
				)
			)[0]?.sha256
		).toBe(sha256);

		// HTML declared as plain text is suspicious: a scan-after file stays
		// up for review, a held one stays held.
		const sneaky = await uploadFile(ctx, {
			name: 'notes.txt',
			content: '<html><script>steal()</script></html>',
			contentType: 'text/plain',
			isPublic: false
		});
		await setTrust(ctx.env, orgId, 'verified');
		await mutateFile(ctx, sneaky.id, { action: 'visibility', public: true });
		await ctx.drainJobs();
		expect(await fileRow(ctx, sneaky.id)).toEqual({
			public: false,
			publish_pending: true,
			quarantined: false
		});
		expect(await verdicts(ctx, sneaky.id)).toContainEqual({
			source: 'sniff',
			verdict: 'suspicious'
		});
		expect(await notifications(ctx, sneaky.id)).toEqual(['held']);
	});
});
