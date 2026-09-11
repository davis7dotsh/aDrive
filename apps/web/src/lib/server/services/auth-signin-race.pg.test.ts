import { Cause, Effect, Exit, Layer } from 'effect';
import Pg from 'pg';
import { expect, it, vi } from 'vitest';
import { pgLayer } from '../pg';
import { TEST_DATABASE_URL } from '../test/database';
import { Auth, AuthLive } from './auth';
import {
	anonymousOrg,
	anonymousUser,
	CurrentOrg,
	CurrentUser
} from './current-org';
import { WorkOSClient, workOSFake, type WorkOSClientShape } from './workos';

it('serializes concurrent first sign-ins and pins both sessions to one personal org', async () => {
	const suffix = crypto.randomUUID().replaceAll('-', '');
	const userId = `user_signin_${suffix}`;
	const secondApplication = `signin-second-${suffix}`;
	const releaseProvider = Promise.withResolvers<void>();
	const exchanges: string[] = [];
	const createdOrgs: string[] = [];
	const providerMemberships: Array<{
		organizationId: string;
		userId: string;
		roleSlug: string;
	}> = [];
	const control = new Pg.Client({ connectionString: TEST_DATABASE_URL });
	await control.connect();
	const provider: WorkOSClientShape = {
		...workOSFake,
		exchangeCode: (code) =>
			Effect.sync(() => {
				exchanges.push(code);
				return {
					sealedSession: `session-${code}`,
					sessionId: `id-${code}`,
					user: {
						id: userId,
						email: `${userId}@example.test`,
						emailVerified: true
					},
					organizationId: null,
					role: null
				};
			}),
		createOrganization: () =>
			Effect.gen(function* () {
				const id = `org_signin_${suffix}_${createdOrgs.length + 1}`;
				createdOrgs.push(id);
				yield* Effect.promise(() => releaseProvider.promise);
				return { id };
			}),
		createOrganizationMembership: (membership) =>
			Effect.sync(() => {
				providerMemberships.push(membership);
			}),
		refresh: (cookie, orgId) =>
			Effect.promise(async () => {
				// A separate connection must see the committed bootstrap before
				// the callback starts the provider's session refresh.
				const { rows } = await control.query(
					`SELECT m.org_id FROM memberships m JOIN org_usage u ON u.org_id = m.org_id
					WHERE m.user_id = $1 AND m.org_id = $2`,
					[userId, orgId]
				);
				expect(rows).toEqual([{ org_id: orgId }]);
				return `pinned:${cookie}:${orgId}`;
			})
	};
	const signIn = (code: string) => {
		const url = new URL(TEST_DATABASE_URL);
		url.searchParams.set(
			'application_name',
			code === 'second' ? secondApplication : `signin-first-${suffix}`
		);
		const layer = AuthLive.pipe(
			Layer.provide(
				Layer.mergeAll(
					pgLayer({ connectionString: url.href }),
					Layer.succeed(CurrentOrg, anonymousOrg),
					Layer.succeed(CurrentUser, anonymousUser),
					Layer.succeed(WorkOSClient, provider)
				)
			)
		);
		return Effect.runPromiseExit(
			Effect.flatMap(Auth, (auth) => auth.completeSignIn(code)).pipe(
				Effect.provide(layer)
			)
		);
	};
	const callbacks: ReturnType<typeof signIn>[] = [];
	try {
		callbacks.push(signIn('first'));
		await vi.waitFor(() => expect(createdOrgs).toHaveLength(1), {
			timeout: 5_000,
			interval: 10
		});
		callbacks.push(signIn('second'));
		await vi.waitFor(
			async () => {
				await control.query('SELECT pg_stat_clear_snapshot()');
				const { rows } = await control.query(
					`SELECT pid FROM pg_stat_activity
					WHERE datname = current_database() AND application_name = $1
					AND wait_event_type = 'Lock' AND query LIKE '%pg_advisory_xact_lock%'`,
					[secondApplication]
				);
				expect(rows).toHaveLength(1);
			},
			{ timeout: 5_000, interval: 10 }
		);
		expect(exchanges).toEqual(['first', 'second']);
		expect(createdOrgs).toHaveLength(1);
		releaseProvider.resolve();
		const outcomes = await Promise.all(callbacks);
		for (const outcome of outcomes) {
			expect(
				Exit.isSuccess(outcome),
				Exit.isFailure(outcome) ? Cause.pretty(outcome.cause) : undefined
			).toBe(true);
		}
		const orgId = createdOrgs[0];
		expect(createdOrgs).toHaveLength(1);
		expect(providerMemberships).toEqual([
			{ organizationId: orgId, userId, roleSlug: 'owner' }
		]);
		expect(
			outcomes.map((outcome) =>
				Exit.isSuccess(outcome) ? outcome.value.sealedSession : null
			)
		).toEqual([
			`pinned:session-first:${orgId}`,
			`pinned:session-second:${orgId}`
		]);
		expect(
			(
				await control.query(
					'SELECT org_id, user_id, role FROM memberships WHERE user_id = $1',
					[userId]
				)
			).rows
		).toEqual([{ org_id: orgId, user_id: userId, role: 'owner' }]);
	} finally {
		releaseProvider.resolve();
		await Promise.all(callbacks);
		try {
			await control.query('DELETE FROM orgs WHERE id = ANY($1::text[])', [
				createdOrgs
			]);
			await control.query('DELETE FROM users WHERE id = $1', [userId]);
		} finally {
			await control.end();
		}
	}
});
