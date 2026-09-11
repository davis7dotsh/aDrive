import Pg from 'pg';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { migrate, MIGRATION_LOCK_NAME } from '../../../scripts/pg-migrate.mjs';
import { TEST_DATABASE_URL } from './test/database';

const createMigrationContext = async () => {
	const schema = `migration_test_${crypto.randomUUID().replaceAll('-', '')}`;
	const client = new Pg.Client({ connectionString: TEST_DATABASE_URL });
	await client.connect();
	await client.query(`CREATE SCHEMA ${schema}`);
	await client.query(`SET search_path TO ${schema}, public`);
	const url = new URL(TEST_DATABASE_URL);
	url.searchParams.set('options', `-csearch_path=${schema},public`);
	url.searchParams.set('application_name', schema);
	return {
		client,
		applicationName: schema,
		migrate: () => migrate({ url: url.href, log: () => undefined }),
		close: async () => {
			try {
				await client.query(`DROP SCHEMA ${schema} CASCADE`);
			} finally {
				await client.end();
			}
		}
	};
};

describe('Postgres migration ledger', () => {
	let context: Awaited<ReturnType<typeof createMigrationContext>>;

	beforeEach(async () => {
		context = await createMigrationContext();
	});
	afterEach(async () => {
		await context?.close();
	});

	it('uses dbmate versions and leaves a second run unchanged', async () => {
		expect(await context.migrate()).toBeGreaterThan(0);
		const { rows } = await context.client.query<{ version: string }>(
			'SELECT version FROM schema_migrations ORDER BY version'
		);
		expect(rows.map((row) => row.version)).toEqual(
			expect.arrayContaining(['0001', '0002'])
		);
		expect(rows.every((row) => /^\d+$/u.test(row.version))).toBe(true);
		await context.client.query('CREATE TABLE migration_sentinel (value text)');
		await context.client.query(
			"INSERT INTO migration_sentinel VALUES ('keep')"
		);
		expect(await context.migrate()).toBe(0);
		expect(
			(await context.client.query('SELECT * FROM migration_sentinel')).rows
		).toEqual([{ value: 'keep' }]);
	});

	it('normalizes legacy versions and duplicates without replaying migrations', async () => {
		await context.migrate();
		await context.client.query(
			`UPDATE schema_migrations
			SET version = '0002_core_schema', applied_at = '2024-01-01T00:00:00Z'
			WHERE version = '0002'`
		);
		await context.client.query(
			"INSERT INTO schema_migrations (version) VALUES ('0001_extensions')"
		);
		await context.client.query('CREATE TABLE migration_sentinel (value text)');
		await context.client.query(
			"INSERT INTO migration_sentinel VALUES ('keep')"
		);

		expect(await context.migrate()).toBe(0);
		const { rows } = await context.client.query<{ version: string }>(
			'SELECT version FROM schema_migrations ORDER BY version'
		);
		expect(rows.every((row) => /^\d+$/u.test(row.version))).toBe(true);
		expect(rows.map((row) => row.version)).toEqual(
			expect.arrayContaining(['0001', '0002'])
		);
		expect(
			(
				await context.client.query<{ applied_at: Date }>(
					"SELECT applied_at FROM schema_migrations WHERE version = '0002'"
				)
			).rows[0]?.applied_at.toISOString()
		).toBe('2024-01-01T00:00:00.000Z');
		expect(
			(await context.client.query('SELECT * FROM migration_sentinel')).rows
		).toEqual([{ value: 'keep' }]);
		expect(await context.migrate()).toBe(0);
	});

	it('accepts dbmate ledgers without an applied_at column', async () => {
		await context.migrate();
		await context.client.query(
			'ALTER TABLE schema_migrations DROP COLUMN applied_at'
		);
		expect(await context.migrate()).toBe(0);
	});

	it('serializes concurrent runs before either reads or changes the ledger', async () => {
		await context.client.query('SELECT pg_advisory_lock(hashtext($1))', [
			MIGRATION_LOCK_NAME
		]);
		const runs = Promise.allSettled([context.migrate(), context.migrate()]);
		try {
			await expect
				.poll(
					async () =>
						(
							await context.client.query<{ waiting: number }>(
								`SELECT count(*)::int AS waiting FROM pg_stat_activity
								 WHERE application_name = $1 AND wait_event = 'advisory'`,
								[context.applicationName]
							)
						).rows[0]?.waiting,
					{ timeout: 5_000 }
				)
				.toBe(2);
		} finally {
			await context.client.query('SELECT pg_advisory_unlock(hashtext($1))', [
				MIGRATION_LOCK_NAME
			]);
			// Settle both clients before teardown even if the waiting assertion fails.
			await runs;
		}
		const counts = (await runs).map((result) => {
			if (result.status === 'rejected') throw result.reason;
			return result.value;
		});
		const ledger = await context.client.query(
			'SELECT version FROM schema_migrations'
		);
		expect(ledger.rows.length).toBeGreaterThan(0);
		expect(counts.sort((a, b) => a - b)).toEqual([0, ledger.rows.length]);
	});
});
