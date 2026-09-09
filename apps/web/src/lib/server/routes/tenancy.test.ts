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
import { currentIdentity, loginAs } from '../test/helpers';

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
