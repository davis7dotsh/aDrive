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
