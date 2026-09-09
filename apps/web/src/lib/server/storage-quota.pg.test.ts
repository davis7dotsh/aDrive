import { Effect } from 'effect';
import { describe, expect, it } from 'vitest';
import { PgSql } from './pg';
import { planLimits } from './plans';
import {
	ensureStorageHeadroom,
	releaseStoredBytes,
	reserveStoredBytes,
	reserveWithinPlan
} from './storage-quota';
import { ensureTenant } from './tenants';
import { testTenant } from './test/org';
import { testPgLayer } from './test/pg';

const run = <A, E>(effect: Effect.Effect<A, E, PgSql>) =>
	Effect.runPromise(effect.pipe(Effect.provide(testPgLayer())));

const status = <A, E extends { readonly _tag: string }, R>(
	effect: Effect.Effect<A, E, R>
) =>
	effect.pipe(
		Effect.as('ok'),
		Effect.catch((failure) =>
			Effect.succeed(
				failure._tag === 'InvalidRequest' && 'status' in failure
					? String(failure.status)
					: failure._tag
			)
		)
	);

describe('per-org stored byte counter', () => {
	it('reserves under the limit, refuses over it, and releases to zero', async () => {
		const suffix = crypto.randomUUID();
		const orgId = `org_quota_${suffix}`;
		const result = await run(
			Effect.gen(function* () {
				const sql = yield* PgSql;
				yield* ensureTenant(sql, testTenant(orgId, `user_quota_${suffix}`));
				const stored = (id: string) =>
					sql<{ stored_bytes: number }>`
						SELECT stored_bytes FROM org_usage WHERE org_id = ${id}`.pipe(
						Effect.map((rows) => rows[0]?.stored_bytes)
					);
				const first = yield* reserveStoredBytes(sql, orgId, 60, 100);
				const refused = yield* status(reserveStoredBytes(sql, orgId, 50, 100));
				const afterRefusal = yield* stored(orgId);
				const shrink = yield* reserveStoredBytes(sql, orgId, -10, 0);
				yield* releaseStoredBytes(sql, orgId, 1_000);
				const floored = yield* stored(orgId);
				const roomy = yield* status(ensureStorageHeadroom(sql, orgId, 5));
				const limit = planLimits('free').storedBytes;
				yield* sql`UPDATE org_usage SET stored_bytes = ${limit - 1} WHERE org_id = ${orgId}`;
				const cramped = yield* status(ensureStorageHeadroom(sql, orgId, 5));
				const lastByte = yield* reserveWithinPlan(sql, orgId, 1);
				const overPlan = yield* status(reserveWithinPlan(sql, orgId, 1));
				const missing = yield* status(
					reserveStoredBytes(sql, `org_missing_${suffix}`, 1, 100)
				);
				return {
					first,
					refused,
					afterRefusal,
					shrink,
					floored,
					roomy,
					cramped,
					lastByte,
					overPlan,
					missing
				};
			})
		);
		expect(result).toEqual({
			first: 60,
			refused: '413',
			afterRefusal: 60,
			shrink: 50,
			floored: 0,
			roomy: 'ok',
			cramped: '413',
			lastByte: planLimits('free').storedBytes,
			overPlan: '413',
			missing: 'StorageError'
		});
	});
});
