import { AutumnNull } from './autumn';
import { Effect, Layer } from 'effect';
import { expect, it } from 'vitest';
import { PgSql } from '../pg';
import { ensureTenant } from '../tenants';
import { testTenant } from '../test/org';
import { testPgLayer } from '../test/pg';
import { Auth, AuthLive } from './auth';
import {
	anonymousOrg,
	anonymousUser,
	CurrentOrg,
	CurrentUser
} from './current-org';
import { WorkOSFake } from './workos';

it('removes an account with approved and consumed device codes without affecting another account', async () => {
	const suffix = crypto.randomUUID();
	const removed = testTenant(`org_removed_${suffix}`, `user_removed_${suffix}`);
	const retained = testTenant(
		`org_retained_${suffix}`,
		`user_retained_${suffix}`
	);
	const removedKey = `removed-key-${suffix}`;
	const retainedKey = `retained-key-${suffix}`;
	const devices = [
		{ id: `approved-${suffix}`, status: 'approved', user: removed, key: null },
		{
			id: `consumed-${suffix}`,
			status: 'consumed',
			user: removed,
			key: removedKey
		},
		{
			id: `retained-${suffix}`,
			status: 'consumed',
			user: retained,
			key: retainedKey
		}
	];
	// Webhooks run without a current tenant and may remove any account.
	const infrastructure = Layer.mergeAll(
		AutumnNull,
		testPgLayer(),
		WorkOSFake,
		Layer.succeed(CurrentOrg, anonymousOrg),
		Layer.succeed(CurrentUser, anonymousUser)
	);
	const layer = AuthLive.pipe(Layer.provideMerge(infrastructure));
	const result = await Effect.runPromise(
		Effect.gen(function* () {
			const sql = yield* PgSql;
			const auth = yield* Auth;
			yield* ensureTenant(sql, removed);
			yield* ensureTenant(sql, retained);
			for (const [tenant, key] of [
				[removed, removedKey],
				[retained, retainedKey]
			] as const) {
				yield* sql`INSERT INTO api_keys (id, name, prefix, secret_hash, created_at, org_id, user_id)
					VALUES (${key}, ${key}, ${key}, 'unused-test-hash', now(), ${tenant.orgId}, ${tenant.userId})`;
			}
			yield* sql`INSERT INTO device_codes ${sql.insert(
				devices.map((device) => ({
					device_code_hash: device.id,
					user_code: device.id,
					status: device.status,
					interval_seconds: 5,
					expires_at: new Date(Date.now() + 60_000).toISOString(),
					created_at: new Date().toISOString(),
					org_id: device.user.orgId,
					user_id: device.user.userId,
					api_key_id: device.key
				}))
			)}`;
			yield* auth.removeUser(removed.userId);
			// WorkOS retries events, so a repeated deletion must remain harmless.
			yield* auth.removeUser(removed.userId);
			return {
				users: yield* sql<{ id: string }>`
					SELECT id FROM users WHERE id IN (${removed.userId}, ${retained.userId})`,
				memberships: yield* sql<{ user_id: string }>`
					SELECT user_id FROM memberships WHERE user_id IN (${removed.userId}, ${retained.userId})`,
				keys: yield* sql<{ id: string }>`
					SELECT id FROM api_keys WHERE id IN (${removedKey}, ${retainedKey})`,
				devices: yield* sql<{
					device_code_hash: string;
					status: string;
					user_id: string | null;
					api_key_id: string | null;
				}>`SELECT device_code_hash, status, user_id, api_key_id FROM device_codes
					WHERE device_code_hash = ANY(${devices.map((device) => device.id)}::text[])
					ORDER BY device_code_hash`
			};
		}).pipe(Effect.provide(layer))
	);
	expect(result.users).toEqual([{ id: retained.userId }]);
	expect(result.memberships).toEqual([{ user_id: retained.userId }]);
	expect(result.keys).toEqual([{ id: retainedKey }]);
	expect(result.devices).toEqual(
		devices.map((device) => ({
			device_code_hash: device.id,
			status: device.user === removed ? 'denied' : device.status,
			user_id: device.user === removed ? null : retained.userId,
			api_key_id: device.user === removed ? null : retainedKey
		}))
	);
});
