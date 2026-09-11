import { Cause, Effect, Exit } from 'effect';
import Pg from 'pg';
import { describe, expect, it } from 'vitest';
import { PgSql } from './pg';
import { ensureTenant, type TenantRows } from './tenants';
import { TEST_DATABASE_URL } from './test/database';
import { testTenant } from './test/org';
import { testPgLayer } from './test/pg';

const run = <A, E>(effect: Effect.Effect<A, E, PgSql>) =>
	Effect.runPromiseExit(effect.pipe(Effect.provide(testPgLayer())));

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

const emptyTenant = { orgs: 0, users: 0, memberships: 0, usage: 0 };

describe('tenant bootstrap transactions', () => {
	it('rolls back a failed final insert and allows a complete retry', async () => {
		const suffix = crypto.randomUUID().replaceAll('-', '');
		const tenant = testTenant(
			`org_bootstrap_${suffix}`,
			`user_bootstrap_${suffix}`
		);
		const trigger = `fail_org_usage_${suffix}`;
		const control = new Pg.Client({ connectionString: TEST_DATABASE_URL });
		await control.connect();
		const bootstrap = () =>
			run(Effect.flatMap(PgSql, (sql) => ensureTenant(sql, tenant)));
		try {
			await control.query(`
				CREATE FUNCTION ${trigger}() RETURNS trigger LANGUAGE plpgsql AS $$
				BEGIN
					RAISE EXCEPTION 'injected org usage failure';
				END
				$$;
				CREATE TRIGGER ${trigger} BEFORE INSERT ON org_usage
				FOR EACH ROW WHEN (NEW.org_id = '${tenant.orgId}')
				EXECUTE FUNCTION ${trigger}();
			`);
			const failed = await bootstrap();
			expect(Exit.isFailure(failed)).toBe(true);
			if (Exit.isFailure(failed)) {
				expect(Cause.pretty(failed.cause)).toContain(
					'injected org usage failure'
				);
			}
			expect(await tenantCounts(control, tenant)).toEqual(emptyTenant);

			await control.query(`DROP TRIGGER ${trigger} ON org_usage`);
			for (let attempt = 0; attempt < 2; attempt += 1) {
				const retried = await bootstrap();
				expect(
					Exit.isSuccess(retried),
					Exit.isFailure(retried) ? Cause.pretty(retried.cause) : undefined
				).toBe(true);
				expect(await tenantCounts(control, tenant)).toEqual({
					orgs: 1,
					users: 1,
					memberships: 1,
					usage: 1
				});
			}
		} finally {
			try {
				await control.query(`DROP TRIGGER IF EXISTS ${trigger} ON org_usage`);
				await control.query(`DROP FUNCTION IF EXISTS ${trigger}()`);
				await control.query('DELETE FROM orgs WHERE id = $1', [tenant.orgId]);
				await control.query('DELETE FROM users WHERE id = $1', [tenant.userId]);
			} finally {
				await control.end();
			}
		}
	});

	it('keeps nested bootstrap rows owned by the outer transaction', async () => {
		const suffix = crypto.randomUUID();
		const tenant = testTenant(`org_nested_${suffix}`, `user_nested_${suffix}`);
		const control = new Pg.Client({ connectionString: TEST_DATABASE_URL });
		await control.connect();
		try {
			const outcome = await run(
				Effect.flatMap(PgSql, (sql) =>
					sql.withTransaction(
						ensureTenant(sql, tenant).pipe(
							Effect.andThen(Effect.fail('cancel outer transaction'))
						)
					)
				)
			);
			expect(Exit.isFailure(outcome)).toBe(true);
			if (Exit.isFailure(outcome)) {
				expect(Cause.pretty(outcome.cause)).toContain(
					'cancel outer transaction'
				);
			}
			expect(await tenantCounts(control, tenant)).toEqual(emptyTenant);
		} finally {
			try {
				await control.query('DELETE FROM orgs WHERE id = $1', [tenant.orgId]);
				await control.query('DELETE FROM users WHERE id = $1', [tenant.userId]);
			} finally {
				await control.end();
			}
		}
	});
});
