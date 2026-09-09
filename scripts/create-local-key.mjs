import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { join } from 'node:path';

// pg is a dependency of apps/web, not the workspace root, so resolve it
// from there.
const require = createRequire(
	join(import.meta.dirname, '..', 'apps', 'web', 'package.json')
);
/** @type {typeof import('pg')} */
const Pg = require('pg');

const LOCAL_DATABASE_URL = 'postgres://adrive:adrive@127.0.0.1:5432/adrive';

// The key lands in the local bootstrap tenant (see src/lib/server/tenants.ts).
const ORG_ID = 'org_local';
const USER_ID = 'user_local';

const prefix = randomBytes(4).toString('hex');
const secret = randomBytes(32).toString('base64url');
const token = `adr_${prefix}_${secret}`;
const hash = createHash('sha256').update(token).digest('hex');

const client = new Pg.Client({
	connectionString: process.env.DATABASE_URL ?? LOCAL_DATABASE_URL
});

try {
	await client.connect();
	await client.query('BEGIN');
	await client.query(
		`INSERT INTO orgs (id, slug, name) VALUES ($1, 'local', 'Local drive')
		ON CONFLICT (id) DO NOTHING`,
		[ORG_ID]
	);
	await client.query(
		`INSERT INTO users (id, email, email_verified)
		VALUES ($1, 'local@adrive.invalid', true) ON CONFLICT (id) DO NOTHING`,
		[USER_ID]
	);
	await client.query(
		`INSERT INTO memberships (org_id, user_id) VALUES ($1, $2)
		ON CONFLICT DO NOTHING`,
		[ORG_ID, USER_ID]
	);
	await client.query(
		`INSERT INTO org_usage (org_id) VALUES ($1) ON CONFLICT DO NOTHING`,
		[ORG_ID]
	);
	await client.query(
		`INSERT INTO api_keys (id, org_id, user_id, name, prefix, secret_hash, created_at)
		VALUES ($1, $2, $3, $4, $5, $6, $7)`,
		[
			randomUUID(),
			ORG_ID,
			USER_ID,
			'local development',
			prefix,
			hash,
			new Date().toISOString()
		]
	);
	await client.query('COMMIT');
	console.log('\nLocal API key (shown once):');
	console.log(token);
} catch (cause) {
	await client.query('ROLLBACK').catch(() => {});
	console.error(cause instanceof Error ? cause.message : String(cause));
	process.exitCode = 1;
} finally {
	await client.end().catch(() => {});
}
