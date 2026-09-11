// Applies apps/web/migrations-pg/*.sql in order against a Postgres
// database, recording each applied file in schema_migrations. Plain SQL
// files with `-- migrate:up` / `-- migrate:down` markers (dbmate format),
// so the same files work with dbmate once that is installed.
//
//   bun scripts/pg-migrate.mjs                  # DATABASE_URL or local default
//   bun scripts/pg-migrate.mjs --url postgres://...
//   bun scripts/pg-migrate.mjs --reset          # drop and recreate public schema first
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import Pg from 'pg';

export const LOCAL_DATABASE_URL =
	'postgres://adrive:adrive@127.0.0.1:5432/adrive';

const migrationsDir = join(
	dirname(fileURLToPath(import.meta.url)),
	'..',
	'migrations-pg'
);

/** @param {string} source */
const upSection = (source) => {
	const start = source.indexOf('-- migrate:up');
	const end = source.indexOf('-- migrate:down');
	if (start < 0) return source;
	return source.slice(
		start + '-- migrate:up'.length,
		end < 0 ? undefined : end
	);
};

/**
 * @param {{ url: string; reset?: boolean; log?: (line: string) => void }} options
 */
export const migrate = async ({ url, reset = false, log = console.log }) => {
	const client = new Pg.Client({ connectionString: url });
	await client.connect();
	try {
		if (reset) {
			await client.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
		}
		await client.query(
			'CREATE TABLE IF NOT EXISTS schema_migrations (version text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())'
		);
		const applied = new Set(
			(await client.query('SELECT version FROM schema_migrations')).rows.map(
				(row) => row.version
			)
		);
		const files = readdirSync(migrationsDir)
			.filter((name) => name.endsWith('.sql'))
			.sort();
		let count = 0;
		for (const file of files) {
			const version = /^(\d+).*\.sql$/u.exec(file)?.[1];
			if (!version) {
				throw new Error(
					`Migration filename must start with a version: ${file}`
				);
			}
			// Earlier runs stored the entire filename stem. Normalize that ledger
			// in place so dbmate recognizes it, preserving data and applied_at.
			const legacyVersion = file.replace(/\.sql$/u, '');
			if (legacyVersion !== version && applied.has(legacyVersion)) {
				if (applied.has(version)) {
					await client.query(
						'DELETE FROM schema_migrations WHERE version = $1',
						[legacyVersion]
					);
				} else {
					await client.query(
						'UPDATE schema_migrations SET version = $1 WHERE version = $2',
						[version, legacyVersion]
					);
					applied.add(version);
				}
			}
			if (applied.has(version)) continue;
			const sql = upSection(readFileSync(join(migrationsDir, file), 'utf8'));
			await client.query('BEGIN');
			try {
				await client.query(sql);
				await client.query(
					'INSERT INTO schema_migrations (version) VALUES ($1)',
					[version]
				);
				await client.query('COMMIT');
			} catch (cause) {
				await client.query('ROLLBACK');
				throw new Error(`Migration ${file} failed: ${String(cause)}`);
			}
			log(`applied ${file}`);
			count += 1;
		}
		if (count === 0) log('no pending migrations');
		return count;
	} finally {
		await client.end();
	}
};

const isMain =
	process.argv[1] &&
	import.meta.url === new URL(`file://${process.argv[1]}`).href;

if (isMain) {
	const urlFlag = process.argv.indexOf('--url');
	const url =
		urlFlag >= 0
			? process.argv[urlFlag + 1]
			: (process.env.DATABASE_URL ?? LOCAL_DATABASE_URL);
	await migrate({ url, reset: process.argv.includes('--reset') });
}
