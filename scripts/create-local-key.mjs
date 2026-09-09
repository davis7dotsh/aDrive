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

const prefix = randomBytes(4).toString('hex');
const secret = randomBytes(32).toString('base64url');
const token = `adr_${prefix}_${secret}`;
const hash = createHash('sha256').update(token).digest('hex');

const client = new Pg.Client({
	connectionString: process.env.DATABASE_URL ?? LOCAL_DATABASE_URL
});

try {
	await client.connect();
	await client.query(
		`INSERT INTO api_keys (id, name, prefix, secret_hash, created_at)
		VALUES ($1, $2, $3, $4, $5)`,
		[randomUUID(), 'local development', prefix, hash, new Date().toISOString()]
	);
	console.log('\nLocal API key (shown once):');
	console.log(token);
} catch (cause) {
	console.error(cause instanceof Error ? cause.message : String(cause));
	process.exitCode = 1;
} finally {
	await client.end().catch(() => {});
}
