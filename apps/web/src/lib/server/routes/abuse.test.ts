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

describe('reports and the kill switch (local platform)', () => {
	let shared: RouteTestContext | undefined;
	const setup = async () => (shared ??= await createRouteContext());

	const runAdmin = async <A>(
		ctx: RouteTestContext,
		program: (
			admin: import('$lib/server/services/admin').Admin['Service']
		) => Effect.Effect<A, unknown>
	) => {
		const { runWorkerProgram } = await import('$lib/server/edge');
		const { Admin } = await import('$lib/server/services/admin');
		return runWorkerProgram(ctx.env, Effect.flatMap(Admin, program));
	};

	it('stores a report filed on the content host', async () => {
		const ctx = await setup();
		await loginAs(ctx, { userId: 'user_reported' });
		const { orgSlug, orgId } = await currentIdentity(ctx);
		const file = await uploadFile(ctx, { name: 'reported.txt' });
		const { GET, POST } = await import('../../../routes/report/+server.js');

		const form = await call(
			GET,
			await ctx.contentEvent({ slug: orgSlug, path: `/report?f=${file.id}` })
		);
		expect(form.status).toBe(200);
		expect(await form.text()).toContain(`value="${file.id}"`);

		const filed = await call(
			POST,
			await ctx.contentEvent({
				slug: orgSlug,
				method: 'POST',
				path: '/report',
				body: JSON.stringify({
					fileId: file.id,
					reason: 'phishing',
					details: 'asks for a password'
				}),
				headers: { 'content-type': 'application/json' }
			})
		);
		expect(filed.status).toBe(201);
		const fromForm = await call(
			POST,
			await ctx.contentEvent({
				slug: orgSlug,
				method: 'POST',
				path: '/report',
				body: new URLSearchParams({
					fileId: file.id,
					reason: 'spam'
				}).toString(),
				headers: { 'content-type': 'application/x-www-form-urlencoded' }
			})
		);
		expect(fromForm.status).toBe(200);
		expect(fromForm.headers.get('content-type')).toContain('text/html');

		const rows = await queryPg(
			ctx.env,
			(sql) => sql<{
				org_id: string;
				version: number;
				reason: string;
				details: string | null;
				reporter_ip_hash: string;
			}>`
				SELECT org_id, version, reason, details, reporter_ip_hash
				FROM reports WHERE file_id = ${file.id} ORDER BY created_at`
		);
		expect(rows).toMatchObject([
			{
				org_id: orgId,
				version: 1,
				reason: 'phishing',
				details: 'asks for a password'
			},
			{ org_id: orgId, version: 1, reason: 'spam', details: null }
		]);
		expect(rows[0]?.reporter_ip_hash).toMatch(/^[0-9a-f]{64}$/);
		expect(rows[0]?.reporter_ip_hash).not.toContain('127.0.0.1');

		// A bad reason and a file this host does not serve are refused.
		await expect(
			call(
				POST,
				await ctx.contentEvent({
					slug: orgSlug,
					method: 'POST',
					path: '/report',
					body: JSON.stringify({ fileId: file.id, reason: 'meh' }),
					headers: { 'content-type': 'application/json' }
				})
			)
		).rejects.toMatchObject({ status: 400 });
		await loginAs(ctx, { userId: 'user_report_other' });
		const other = await currentIdentity(ctx);
		await expect(
			call(
				POST,
				await ctx.contentEvent({
					slug: other.orgSlug,
					method: 'POST',
					path: '/report',
					body: JSON.stringify({ fileId: file.id, reason: 'spam' }),
					headers: { 'content-type': 'application/json' }
				})
			)
		).rejects.toMatchObject({ status: 404 });
		ctx.deniedRateLimits.add('anonymous');
		expect(
			(
				await call(
					POST,
					await ctx.contentEvent({
						slug: orgSlug,
						method: 'POST',
						path: '/report',
						body: JSON.stringify({ fileId: file.id, reason: 'spam' }),
						headers: { 'content-type': 'application/json' }
					})
				)
			).status
		).toBe(429);
		ctx.deniedRateLimits.delete('anonymous');
	});

	it('suspends an org: 404 on its host, 401 for its credentials, and back again', async () => {
		const ctx = await setup();
		await loginAs(ctx, { userId: 'user_killed' });
		const { orgSlug, orgId } = await currentIdentity(ctx);
		const file = await uploadFile(ctx, { name: 'live.txt', content: 'live' });
		const { POST: keysPOST } =
			await import('../../../routes/api/auth/keys/+server.js');
		const created = await call(
			keysPOST,
			ctx.event({
				method: 'POST',
				path: '/api/auth/keys',
				body: JSON.stringify({ name: 'killed cli' }),
				headers: { 'content-type': 'application/json' }
			})
		);
		const { token } = (await created.json()) as { token: string };
		const { GET: filesGET } =
			await import('../../../routes/api/files/+server.js');
		const asKey = () =>
			call(
				filesGET,
				ctx.event({
					path: '/api/files',
					headers: { authorization: `Bearer ${token}` }
				})
			);
		expect((await asKey()).status).toBe(200);
		const { resolveContentHost } = await import('$lib/server/content-host');
		expect((await resolveContentHost(ctx.env, orgSlug))._tag).toBe('Found');

		const suspended = await runAdmin(ctx, (admin) => admin.suspendOrg(orgId));
		expect(suspended.trust).toBe('suspended');
		// The slug cache was dropped, so the host is gone at once.
		await expect(
			ctx.contentEvent({ slug: orgSlug, path: `/f/${file.id}` })
		).rejects.toMatchObject({ status: 404 });
		await expect(
			ctx.contentEvent({ slug: orgSlug, path: `/report?f=${file.id}` })
		).rejects.toMatchObject({ status: 404 });
		await expect(asKey()).rejects.toMatchObject({ status: 401 });
		await expect(
			call(filesGET, ctx.event({ path: '/api/files' }))
		).rejects.toMatchObject({ status: 401 });
		// Signing in again does not lift it.
		await loginAs(ctx, { userId: 'user_killed', orgId });
		await expect(
			call(filesGET, ctx.event({ path: '/api/files' }))
		).rejects.toMatchObject({ status: 401 });

		const restored = await runAdmin(ctx, (admin) => admin.restoreOrg(orgId));
		expect(restored.trust).toBe('verified');
		expect((await asKey()).status).toBe(200);
		const { GET: serveGET } = await import('../../../routes/f/[id]/+server.js');
		const served = await call(
			serveGET,
			await ctx.contentEvent({
				slug: orgSlug,
				path: `/f/${file.id}`,
				params: { id: file.id }
			})
		);
		expect(await served.text()).toBe('live');
	});
});

describe('admin surface (local platform)', () => {
	let shared: RouteTestContext | undefined;
	const setup = async () => (shared ??= await createRouteContext());

	const adminCall = async (
		ctx: RouteTestContext,
		method: 'GET' | 'PATCH' | 'POST',
		path: string,
		params: Record<string, string> = {},
		body?: unknown
	) => {
		const handlers: Record<string, () => Promise<Record<string, unknown>>> = {
			'/api/admin/overview': () =>
				import('../../../routes/api/admin/overview/+server.js'),
			'/api/admin/reports': () =>
				import('../../../routes/api/admin/reports/[id]/+server.js'),
			'/api/admin/orgs': () =>
				import('../../../routes/api/admin/orgs/[id]/+server.js'),
			'/api/admin/files': () =>
				import('../../../routes/api/admin/files/[id]/+server.js'),
			'/api/admin/hashes': () =>
				import('../../../routes/api/admin/hashes/+server.js')
		};
		const key = Object.keys(handlers).find((prefix) => path.startsWith(prefix));
		const loader = key ? handlers[key] : undefined;
		if (!loader) throw new Error(`No handler for ${path}`);
		const module = await loader();
		const handler = module[method];
		if (typeof handler !== 'function') throw new Error(`No ${method} ${path}`);
		return call(
			handler as (event: Parameters<typeof call>[1]) => Promise<Response>,
			ctx.event({
				method,
				path,
				params,
				...(body === undefined
					? {}
					: {
							body: JSON.stringify(body),
							headers: { 'content-type': 'application/json' }
						})
			})
		);
	};

	it('rejects everyone but the listed admins, then works the queues', async () => {
		const ctx = await setup();
		// The reported org and file.
		await loginAs(ctx, { userId: 'user_admin_target' });
		const target = await currentIdentity(ctx);
		const file = await uploadFile(ctx, {
			name: 'reported.html',
			content: '<html><body>hi</body></html>',
			contentType: 'text/html'
		});
		const { POST: reportPOST } =
			await import('../../../routes/report/+server.js');
		await call(
			reportPOST,
			await ctx.contentEvent({
				slug: target.orgSlug,
				method: 'POST',
				path: '/report',
				body: JSON.stringify({ fileId: file.id, reason: 'malware' }),
				headers: { 'content-type': 'application/json' }
			})
		);
		const { POST: keysPOST } =
			await import('../../../routes/api/auth/keys/+server.js');
		const { token } = (await (
			await call(
				keysPOST,
				ctx.event({
					method: 'POST',
					path: '/api/auth/keys',
					body: JSON.stringify({ name: 'admin probe' }),
					headers: { 'content-type': 'application/json' }
				})
			)
		).json()) as { token: string };

		// Nobody is an admin until ADMIN_USER_IDS says so; a session that is
		// listed still cannot use an API key for it.
		ctx.env.ADMIN_USER_IDS = '';
		await expect(
			adminCall(ctx, 'GET', '/api/admin/overview')
		).rejects.toMatchObject({ status: 403 });
		await loginAs(ctx, { userId: 'user_operator' });
		await expect(
			adminCall(ctx, 'GET', '/api/admin/overview')
		).rejects.toMatchObject({ status: 403 });
		ctx.env.ADMIN_USER_IDS = ' user_operator, user_other ';
		const { GET: overviewGET } =
			await import('../../../routes/api/admin/overview/+server.js');
		await expect(
			call(
				overviewGET,
				ctx.event({
					path: '/api/admin/overview',
					headers: { authorization: `Bearer ${token}` }
				})
			)
		).rejects.toMatchObject({ status: 403 });
		ctx.cookies.delete('__Host-adrive-wos');
		await expect(
			adminCall(ctx, 'GET', '/api/admin/overview')
		).rejects.toMatchObject({ status: 401 });
		await loginAs(ctx, { userId: 'user_operator' });

		const overview = (await (
			await adminCall(ctx, 'GET', '/api/admin/overview')
		).json()) as {
			reports: Array<{ id: string; fileId: string; reason: string }>;
			held: Array<{ id: string }>;
			failedJobs: Array<unknown>;
			orgs: Array<{ id: string; slug: string; trust: string }>;
		};
		const report = overview.reports.find((entry) => entry.fileId === file.id);
		expect(report).toMatchObject({ reason: 'malware' });
		expect(overview.orgs.map((org) => org.id)).toContain(target.orgId);

		// Quarantine the reported file, resolve the report, block its hash.
		expect(
			(
				await adminCall(
					ctx,
					'PATCH',
					`/api/admin/files/${file.id}`,
					{
						id: file.id
					},
					{ verdict: 'malicious' }
				)
			).status
		).toBe(200);
		expect(
			(
				await queryPg(
					ctx.env,
					(sql) => sql<{ quarantined: boolean; public: boolean }>`
						SELECT quarantined, public FROM files WHERE id = ${file.id}`
				)
			)[0]
		).toEqual({ quarantined: true, public: false });
		expect(
			(
				await adminCall(
					ctx,
					'PATCH',
					`/api/admin/reports/${report?.id ?? ''}`,
					{
						id: report?.id ?? ''
					},
					{ resolution: 'quarantined' }
				)
			).status
		).toBe(200);
		await expect(
			adminCall(
				ctx,
				'PATCH',
				`/api/admin/reports/${report?.id ?? ''}`,
				{
					id: report?.id ?? ''
				},
				{ resolution: 'dismissed' }
			)
		).rejects.toMatchObject({ status: 404 });
		const afterResolve = (await (
			await adminCall(ctx, 'GET', '/api/admin/overview')
		).json()) as {
			reports: Array<{ id: string }>;
			held: Array<{ id: string; quarantined: boolean }>;
		};
		expect(afterResolve.reports.map((entry) => entry.id)).not.toContain(
			report?.id
		);
		expect(
			afterResolve.held.find((entry) => entry.id === file.id)
		).toMatchObject({ quarantined: true });

		// Cleared again: private, no longer quarantined, owner may republish.
		await adminCall(
			ctx,
			'PATCH',
			`/api/admin/files/${file.id}`,
			{
				id: file.id
			},
			{ verdict: 'clean' }
		);
		expect(
			(
				await queryPg(
					ctx.env,
					(sql) => sql<{ quarantined: boolean; public: boolean }>`
						SELECT quarantined, public FROM files WHERE id = ${file.id}`
				)
			)[0]
		).toEqual({ quarantined: false, public: false });
		expect(
			(
				await queryPg(
					ctx.env,
					(sql) => sql<{ details: { by?: string } }>`
						SELECT details FROM scan_verdicts
						WHERE file_id = ${file.id} AND source = 'admin'`
				)
			)[0]?.details
		).toEqual({ by: 'user_operator' });

		// A live file the scanner flagged after publish is listed for review
		// until an operator rules on it.
		await queryPg(
			ctx.env,
			(sql) => sql`
				UPDATE orgs SET trust = 'established' WHERE id = ${target.orgId}`
		);
		await loginAs(ctx, { userId: 'user_admin_target', orgId: target.orgId });
		const flagged = await uploadFile(ctx, {
			name: 'flagged.txt',
			content: '<html><script>x()</script></html>',
			contentType: 'text/plain'
		});
		await ctx.drainJobs();
		await loginAs(ctx, { userId: 'user_operator' });
		const withFlagged = (await (
			await adminCall(ctx, 'GET', '/api/admin/overview')
		).json()) as { held: Array<{ id: string; public: boolean }> };
		expect(
			withFlagged.held.find((entry) => entry.id === flagged.id)
		).toMatchObject({ public: true });
		await adminCall(
			ctx,
			'PATCH',
			`/api/admin/files/${flagged.id}`,
			{ id: flagged.id },
			{ verdict: 'clean' }
		);
		const afterClear = (await (
			await adminCall(ctx, 'GET', '/api/admin/overview')
		).json()) as { held: Array<{ id: string }> };
		expect(afterClear.held.map((entry) => entry.id)).not.toContain(flagged.id);

		expect(
			(
				await adminCall(
					ctx,
					'POST',
					'/api/admin/hashes',
					{},
					{
						sha256: 'A'.repeat(64),
						reason: 'test list'
					}
				)
			).status
		).toBe(201);
		await expect(
			adminCall(ctx, 'POST', '/api/admin/hashes', {}, { sha256: 'nope' })
		).rejects.toMatchObject({ status: 400 });

		// Org actions: bump, suspend, restore.
		const bumped = (await (
			await adminCall(
				ctx,
				'PATCH',
				`/api/admin/orgs/${target.orgId}`,
				{
					id: target.orgId
				},
				{ action: 'trust', trust: 'established' }
			)
		).json()) as { org: { trust: string } };
		expect(bumped.org.trust).toBe('established');
		const suspended = (await (
			await adminCall(
				ctx,
				'PATCH',
				`/api/admin/orgs/${target.orgId}`,
				{
					id: target.orgId
				},
				{ action: 'suspend' }
			)
		).json()) as { org: { trust: string } };
		expect(suspended.org.trust).toBe('suspended');
		await expect(
			ctx.contentEvent({ slug: target.orgSlug, path: `/f/${file.id}` })
		).rejects.toMatchObject({ status: 404 });
		const restored = (await (
			await adminCall(
				ctx,
				'PATCH',
				`/api/admin/orgs/${target.orgId}`,
				{
					id: target.orgId
				},
				{ action: 'restore' }
			)
		).json()) as { org: { trust: string } };
		expect(restored.org.trust).toBe('verified');
		await expect(
			adminCall(
				ctx,
				'PATCH',
				'/api/admin/orgs/org_missing',
				{
					id: 'org_missing'
				},
				{ action: 'suspend' }
			)
		).rejects.toMatchObject({ status: 404 });
	});
});
