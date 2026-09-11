import { Effect, Layer } from 'effect';
import { expect, it } from 'vitest';
import { PgSql } from '../pg';
import { ensureTenant } from '../tenants';
import { testTenant } from '../test/org';
import { testPgLayer } from '../test/pg';
import { Auth, AuthLive } from './auth';
import { CurrentOrg, CurrentUser } from './current-org';
import { WorkOSClient, workOSFake, type WorkOSClientShape } from './workos';

const authLayer = (client: WorkOSClientShape, orgId: string, userId: string) =>
	AuthLive.pipe(
		Layer.provideMerge(
			Layer.mergeAll(
				testPgLayer(),
				Layer.succeed(WorkOSClient, client),
				Layer.succeed(CurrentOrg, { id: orgId }),
				Layer.succeed(CurrentUser, { id: userId })
			)
		)
	);

it.each(['member', 'admin', null])(
	'mirrors an invited member role %s without granting ownership',
	async (role) => {
		const suffix = crypto.randomUUID();
		const owner = testTenant(`org_roles_${suffix}`, `owner_${suffix}`);
		const userId = `invited_${suffix}`;
		const result = await Effect.runPromise(
			Effect.gen(function* () {
				const sql = yield* PgSql;
				yield* ensureTenant(sql, owner);
				const auth = yield* Auth;
				yield* auth.completeSignIn('invitation-code');
				return yield* sql<{ user_id: string; role: string }>`
			SELECT user_id, role FROM memberships WHERE org_id = ${owner.orgId} ORDER BY user_id`;
			}).pipe(
				Effect.provide(
					authLayer(
						{
							...workOSFake,
							exchangeCode: () =>
								Effect.succeed({
									sealedSession: 'invited-session',
									sessionId: 'session',
									role,
									user: {
										id: userId,
										email: `${userId}@example.test`,
										emailVerified: true
									},
									organizationId: owner.orgId
								})
						},
						owner.orgId,
						userId
					)
				)
			)
		);
		expect(result).toEqual([
			{ user_id: userId, role: role ?? 'member' },
			{ user_id: owner.userId, role: 'owner' }
		]);
	}
);

it('refreshes mirrored permissions for browser sessions and existing API keys', async () => {
	const suffix = crypto.randomUUID();
	const tenant = testTenant(
		`org_role_change_${suffix}`,
		`user_role_change_${suffix}`
	);
	const result = await Effect.runPromise(
		Effect.gen(function* () {
			const sql = yield* PgSql;
			yield* ensureTenant(sql, tenant);
			const auth = yield* Auth;
			const key = yield* auth.createApiKey('Before role change');
			yield* auth.completeSignIn('provider-code');
			const signedIn = yield* sql<{
				role: string;
			}>`SELECT role FROM memberships WHERE org_id = ${tenant.orgId} AND user_id = ${tenant.userId}`;
			// A later verified session also repairs a stale local role mirror.
			yield* sql`UPDATE memberships SET role = 'owner' WHERE org_id = ${tenant.orgId} AND user_id = ${tenant.userId}`;
			const session = yield* auth.resolveSession('provider-session');
			const api = yield* auth.resolveApiKey(key.token);
			return {
				signedIn: signedIn[0]?.role,
				session: session.auth?.role,
				api: api.role
			};
		}).pipe(
			Effect.provide(
				authLayer(
					{
						...workOSFake,
						exchangeCode: () =>
							Effect.succeed({
								sealedSession: 'provider-session',
								sessionId: 'session',
								role: 'member',
								user: {
									id: tenant.userId,
									email: tenant.email,
									emailVerified: true
								},
								organizationId: tenant.orgId
							}),
						loadSession: () =>
							Effect.succeed({
								authenticated: true,
								sessionId: 'session',
								userId: tenant.userId,
								orgId: tenant.orgId,
								role: 'member'
							})
					},
					tenant.orgId,
					tenant.userId
				)
			)
		)
	);
	expect(result).toEqual({
		signedIn: 'member',
		session: 'member',
		api: 'member'
	});
});
