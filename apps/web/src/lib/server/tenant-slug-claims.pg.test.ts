import { Cause, Effect, Exit } from 'effect';
import Pg from 'pg';
import { describe, expect, it } from 'vitest';
import { StorageError } from './errors';
import { PgSql } from './pg';
import { ensureTenant, type TenantRows } from './tenants';
import { TEST_DATABASE_URL } from './test/database';
import { testTenant } from './test/org';
import { testPgLayer } from './test/pg';

const bootstrap = (tenant: TenantRows) =>
	Effect.runPromiseExit(
		Effect.flatMap(PgSql, (sql) => ensureTenant(sql, tenant)).pipe(
			Effect.provide(testPgLayer())
		)
	);

const tenantCounts = async (client: Pg.Client, tenant: TenantRows) =>
	(
		await client.query(
			`SELECT
				(SELECT count(*)::int FROM orgs WHERE id = $1) AS orgs,
				(SELECT count(*)::int FROM users WHERE id = $2) AS users,
				(SELECT count(*)::int FROM memberships WHERE org_id = $1 AND user_id = $2) AS memberships,
				(SELECT count(*)::int FROM org_usage WHERE org_id = $1) AS usage`,
			[tenant.orgId, tenant.userId]
		)
	).rows[0];

const fixture = () => {
	const suffix = crypto.randomUUID().replaceAll('-', '').slice(0, 16);
	return {
		ownerId: `org_reserved_${suffix}`,
		ownerSlug: `owner-${suffix}`,
		tenant: {
			...testTenant(`org_claim_${suffix}`, `user_claim_${suffix}`),
			slug: `parked-${suffix}`
		}
	};
};

describe('tenant bootstrap slug reservations', () => {
	it('rejects an active parked slug atomically, then allows it after expiry', async () => {
		const { ownerId, ownerSlug, tenant } = fixture();
		const control = new Pg.Client({ connectionString: TEST_DATABASE_URL });
		await control.connect();
		try {
			await control.query(
				'INSERT INTO orgs (id, slug, name) VALUES ($1, $2, $3)',
				[ownerId, ownerSlug, 'Reservation owner']
			);
			await control.query(
				'INSERT INTO org_slug_history (slug, org_id, released_at) VALUES ($1, $2, now())',
				[tenant.slug, ownerId]
			);

			const rejected = await bootstrap(tenant);
			expect(Exit.isFailure(rejected)).toBe(true);
			if (Exit.isFailure(rejected)) {
				expect(Cause.squash(rejected.cause)).toBeInstanceOf(StorageError);
			}
			expect(await tenantCounts(control, tenant)).toEqual({
				orgs: 0,
				users: 0,
				memberships: 0,
				usage: 0
			});
			expect(
				(
					await control.query(
						'SELECT org_id FROM org_slug_history WHERE slug = $1',
						[tenant.slug]
					)
				).rows
			).toEqual([{ org_id: ownerId }]);

			await control.query(
				"UPDATE org_slug_history SET released_at = now() - interval '31 days' WHERE slug = $1",
				[tenant.slug]
			);
			const claimed = await bootstrap(tenant);
			expect(
				Exit.isSuccess(claimed),
				Exit.isFailure(claimed) ? Cause.pretty(claimed.cause) : undefined
			).toBe(true);
			expect(await tenantCounts(control, tenant)).toEqual({
				orgs: 1,
				users: 1,
				memberships: 1,
				usage: 1
			});
		} finally {
			try {
				await control.query('DELETE FROM orgs WHERE id = ANY($1::text[])', [
					[ownerId, tenant.orgId]
				]);
				await control.query('DELETE FROM users WHERE id = $1', [tenant.userId]);
			} finally {
				await control.end();
			}
		}
	});

	it('keeps an existing organization unchanged when bootstrap carries a reserved slug', async () => {
		const { ownerId, ownerSlug, tenant } = fixture();
		const currentSlug = tenant.slug.replace('parked-', 'current-');
		const control = new Pg.Client({ connectionString: TEST_DATABASE_URL });
		await control.connect();
		try {
			await control.query(
				'INSERT INTO orgs (id, slug, name) VALUES ($1, $2, $3), ($4, $5, $6)',
				[
					ownerId,
					ownerSlug,
					'Reservation owner',
					tenant.orgId,
					currentSlug,
					'Existing organization'
				]
			);
			await control.query(
				'INSERT INTO org_slug_history (slug, org_id, released_at) VALUES ($1, $2, now())',
				[tenant.slug, ownerId]
			);

			const ensured = await bootstrap(tenant);
			expect(
				Exit.isSuccess(ensured),
				Exit.isFailure(ensured) ? Cause.pretty(ensured.cause) : undefined
			).toBe(true);
			expect(
				(
					await control.query('SELECT slug, name FROM orgs WHERE id = $1', [
						tenant.orgId
					])
				).rows
			).toEqual([{ slug: currentSlug, name: 'Existing organization' }]);
			expect(await tenantCounts(control, tenant)).toEqual({
				orgs: 1,
				users: 1,
				memberships: 1,
				usage: 1
			});
		} finally {
			try {
				await control.query('DELETE FROM orgs WHERE id = ANY($1::text[])', [
					[ownerId, tenant.orgId]
				]);
				await control.query('DELETE FROM users WHERE id = $1', [tenant.userId]);
			} finally {
				await control.end();
			}
		}
	});
});
