import { readFileSync } from 'node:fs';
import Pg from 'pg';
import { describe, expect, it } from 'vitest';
import { TEST_DATABASE_URL } from './test/database';

const migrationUp = (name: string) => {
	const source = readFileSync(
		new URL(`../../../migrations-pg/${name}`, import.meta.url),
		'utf8'
	);
	return source.split('-- migrate:up')[1]!.split('-- migrate:down')[0]!;
};

const tenancy = migrationUp('0004_tenancy.sql');

const withPredecessor = async <A>(
	test: (client: Pg.Client, schema: string) => Promise<A>
) => {
	const schema = `tenancy_migration_${crypto.randomUUID().replaceAll('-', '')}`;
	const client = new Pg.Client({ connectionString: TEST_DATABASE_URL });
	await client.connect();
	let schemaCreated = false;
	try {
		await client.query(`CREATE SCHEMA ${schema}`);
		schemaCreated = true;
		await client.query(`SET search_path TO ${schema}, public`);
		for (const name of [
			'0001_extensions.sql',
			'0002_core_schema.sql',
			'0003_search_normalization.sql'
		]) {
			await client.query('BEGIN');
			await client.query(migrationUp(name));
			await client.query('COMMIT');
		}
		return await test(client, schema);
	} finally {
		try {
			await client.query('ROLLBACK');
			if (schemaCreated) await client.query(`DROP SCHEMA ${schema} CASCADE`);
		} finally {
			await client.end();
		}
	}
};

const predecessorSnapshot = async (client: Pg.Client, schema: string) => ({
	columns: (
		await client.query(
			`SELECT table_name, column_name, data_type, is_nullable, column_default
			FROM information_schema.columns WHERE table_schema = $1
			ORDER BY table_name, ordinal_position`,
			[schema]
		)
	).rows,
	files: (await client.query('SELECT * FROM files ORDER BY id')).rows,
	versions: (
		await client.query('SELECT * FROM file_versions ORDER BY file_id, version')
	).rows,
	keys: (await client.query('SELECT * FROM api_keys ORDER BY id')).rows,
	sessions: (
		await client.query('SELECT * FROM dashboard_sessions ORDER BY token_hash')
	).rows,
	credentials: (
		await client.query('SELECT * FROM credential_state ORDER BY id')
	).rows
});

describe('fresh hosted tenancy bootstrap', () => {
	it.each([true, false])(
		'refuses populated predecessors and preserves schema/auth state (files=%s)',
		async (withFiles) =>
			withPredecessor(async (client, schema) => {
				await client.query(`
					INSERT INTO api_keys (id, name, prefix, secret_hash, created_at)
					VALUES ('legacy-key', 'Keep key', '1234abcd', 'original-key-hash', now());
					INSERT INTO dashboard_sessions (token_hash, created_at, expires_at, last_used_at)
					VALUES ('legacy-session', now(), now() + interval '1 day', now());
					INSERT INTO credential_state (id, passcode_hash, rotated_at)
					VALUES (1, repeat('a', 64), now());
				`);
				if (withFiles) {
					await client.query(`
						INSERT INTO files (id, display_name, content_type, size_bytes, created_at, updated_at)
						VALUES ('legacy-file', 'Keep file', 'text/plain', 4, now(), now());
						INSERT INTO file_versions
						(file_id, version, r2_key, size_bytes, content_type, created_at, text_content)
						VALUES ('legacy-file', 1, 'legacy/blob', 4, 'text/plain', now(), 'keep');
					`);
				}
				const before = await predecessorSnapshot(client, schema);
				await client.query('BEGIN');
				await expect(client.query(tenancy)).rejects.toMatchObject({
					code: '55000',
					message: 'Tenancy bootstrap requires an empty target database',
					hint: expect.stringContaining('Keep the existing drive database')
				});
				await client.query('ROLLBACK');
				expect(await predecessorSnapshot(client, schema)).toEqual(before);
				expect(
					(
						await client.query(
							`SELECT table_name FROM information_schema.tables
							WHERE table_schema = $1 AND table_name IN ('orgs', 'users', 'memberships')`,
							[schema]
						)
					).rows
				).toEqual([]);
			})
	);

	it('bootstraps an empty predecessor into the hosted schema', async () =>
		withPredecessor(async (client, schema) => {
			await client.query('BEGIN');
			await client.query(tenancy);
			await client.query('COMMIT');
			const { rows } = await client.query(
				`SELECT table_name, column_name, is_nullable
				FROM information_schema.columns
				WHERE table_schema = $1 AND table_name = 'files' AND column_name = 'org_id'`,
				[schema]
			);
			expect(rows).toEqual([
				{ table_name: 'files', column_name: 'org_id', is_nullable: 'NO' }
			]);
			expect(
				(
					await client.query(
						`SELECT table_name FROM information_schema.tables
						WHERE table_schema = $1 AND table_name IN
						('orgs', 'users', 'memberships', 'org_usage', 'dashboard_sessions', 'credential_state')
						ORDER BY table_name`,
						[schema]
					)
				).rows
			).toEqual(
				['memberships', 'org_usage', 'orgs', 'users'].map((table_name) => ({
					table_name
				}))
			);
		}));
});
