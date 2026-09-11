import { Effect, Layer } from 'effect';
import { describe, expect, it, onTestFinished, vi } from 'vitest';
import { StorageError } from '../errors';
import { PgSql } from '../pg';
import { ensureTenant } from '../tenants';
import { testTenant } from '../test/org';
import { testPgLayer } from '../test/pg';
import { Auth, AuthLive } from './auth';
import { AutumnClient, autumnFake, type AutumnClientShape } from './autumn';
import {
	anonymousOrg,
	anonymousUser,
	CurrentOrg,
	CurrentUser
} from './current-org';
import { WorkOSClient, workOSFake, type WorkOSClientShape } from './workos';

const authLayer = (
	exchangeCode: WorkOSClientShape['exchangeCode'],
	ensureCustomer: AutumnClientShape['ensureCustomer']
) =>
	AuthLive.pipe(
		Layer.provideMerge(
			Layer.mergeAll(
				testPgLayer(),
				Layer.succeed(WorkOSClient, { ...workOSFake, exchangeCode }),
				Layer.succeed(AutumnClient, { ...autumnFake, ensureCustomer }),
				Layer.succeed(CurrentOrg, anonymousOrg),
				Layer.succeed(CurrentUser, anonymousUser)
			)
		)
	);

const exchanged = (
	orgId: string,
	userId: string,
	email: string,
	role: string
) => ({
	sealedSession: `session-${userId}`,
	sessionId: `id-${userId}`,
	organizationId: orgId,
	role,
	user: { id: userId, email, emailVerified: true }
});

describe('sign-in billing customer identity', () => {
	it('creates an absent org customer from its stored name and oldest known owner on a member login', async () => {
		const suffix = crypto.randomUUID().replaceAll('-', '');
		const owner = testTenant(`org_customer_${suffix}`, `owner_${suffix}`);
		const laterOwner = testTenant(owner.orgId, `later_owner_${suffix}`);
		const memberId = `member_${suffix}`;
		const ensureCustomer = vi.fn<AutumnClientShape['ensureCustomer']>(
			() => Effect.void
		);
		const result = await Effect.runPromise(
			Effect.gen(function* () {
				const sql = yield* PgSql;
				// The organization existed before billing was enabled; the new
				// customer's first creation attempt comes from an invited member.
				yield* ensureTenant(sql, owner);
				yield* ensureTenant(sql, laterOwner);
				yield* sql`UPDATE orgs SET name = 'Studio billing' WHERE id = ${owner.orgId}`;
				yield* sql`UPDATE users SET created_at = '2026-01-01T00:00:00Z'
					WHERE id = ${owner.userId}`;
				yield* sql`UPDATE users SET created_at = '2026-01-02T00:00:00Z'
					WHERE id = ${laterOwner.userId}`;
				const auth = yield* Auth;
				return yield* auth.completeSignIn('member-first');
			}).pipe(
				Effect.provide(
					authLayer(
						() =>
							Effect.succeed(
								exchanged(
									owner.orgId,
									memberId,
									'member-personal@example.test',
									'member'
								)
							),
						ensureCustomer
					)
				)
			)
		);
		expect(result.sealedSession).toBe(`session-${memberId}`);
		expect(ensureCustomer).toHaveBeenCalledOnce();
		expect(ensureCustomer).toHaveBeenCalledWith({
			customerId: owner.orgId,
			name: 'Studio billing',
			email: owner.email
		});
	});

	it('defers creation without an owner and uses the updated owner email on a later sign-in', async () => {
		const suffix = crypto.randomUUID().replaceAll('-', '');
		const member = testTenant(`org_defer_${suffix}`, `member_${suffix}`);
		const owner = testTenant(member.orgId, `owner_${suffix}`);
		const ensureCustomer = vi.fn<AutumnClientShape['ensureCustomer']>(
			() => Effect.void
		);
		const result = await Effect.runPromise(
			Effect.gen(function* () {
				const sql = yield* PgSql;
				yield* ensureTenant(sql, { ...member, role: 'member' });
				yield* ensureTenant(sql, { ...owner, role: 'member' });
				const auth = yield* Auth;
				const deferred = yield* auth.completeSignIn('member');
				expect(ensureCustomer).not.toHaveBeenCalled();
				const resumed = yield* auth.completeSignIn('owner');
				return { deferred, resumed };
			}).pipe(
				Effect.provide(
					authLayer(
						(code) =>
							Effect.succeed(
								code === 'owner'
									? exchanged(
											member.orgId,
											owner.userId,
											'updated-owner@example.test',
											'owner'
										)
									: exchanged(
											member.orgId,
											member.userId,
											'updated-member@example.test',
											'member'
										)
							),
						ensureCustomer
					)
				)
			)
		);
		expect(result.deferred.sealedSession).toBe(`session-${member.userId}`);
		expect(result.resumed.sealedSession).toBe(`session-${owner.userId}`);
		expect(ensureCustomer).toHaveBeenCalledOnce();
		expect(ensureCustomer).toHaveBeenCalledWith({
			customerId: member.orgId,
			name: member.name,
			email: 'updated-owner@example.test'
		});
	});

	it('keeps committed sign-in successful when customer creation fails and retries later', async () => {
		const suffix = crypto.randomUUID().replaceAll('-', '');
		const owner = testTenant(`org_retry_${suffix}`, `owner_${suffix}`);
		const ensureCustomer = vi
			.fn<AutumnClientShape['ensureCustomer']>(() => Effect.void)
			.mockImplementationOnce(() =>
				Effect.fail(
					new StorageError({
						operation: 'create Autumn customer',
						cause: 'provider unavailable'
					})
				)
			);
		const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
		onTestFinished(() => logged.mockRestore());
		const sessions = await Effect.runPromise(
			Effect.gen(function* () {
				const sql = yield* PgSql;
				yield* ensureTenant(sql, owner);
				const auth = yield* Auth;
				return [
					yield* auth.completeSignIn('first'),
					yield* auth.completeSignIn('retry')
				];
			}).pipe(
				Effect.provide(
					authLayer(
						() =>
							Effect.succeed(
								exchanged(owner.orgId, owner.userId, owner.email, 'owner')
							),
						ensureCustomer
					)
				)
			)
		);
		expect(sessions).toEqual([
			{ sealedSession: `session-${owner.userId}` },
			{ sealedSession: `session-${owner.userId}` }
		]);
		expect(ensureCustomer).toHaveBeenCalledTimes(2);
		expect(ensureCustomer.mock.calls[0]).toEqual(ensureCustomer.mock.calls[1]);
		expect(logged).toHaveBeenCalledOnce();
	});
});
