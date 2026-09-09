// One-off data move from the D1 export of a single-tenant adrive instance
// into Postgres. Reads the SQL dump produced by
// `wrangler d1 export DB --env production --remote --output d1.sql`,
// replays it into an in-memory SQLite database, then copies each table
// row by row with type conversion (0/1 -> boolean, ISO text -> timestamptz).
//
//   bun apps/web/scripts/d1-to-postgres.mjs --dump d1.sql --url postgres://...
//   bun apps/web/scripts/d1-to-postgres.mjs --dump d1.sql --url ... --wipe   # truncate first
//
// R2 objects do not move. Keyword search documents are rebuilt from the
// copied rows; semantic vectors are not carried over (Vectorize is gone),
// so every file is left in index_state = 'pending' for the queue/cron to
// re-embed.
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import Pg from 'pg';

const arg = (flag) => {
	const index = process.argv.indexOf(flag);
	return index >= 0 ? process.argv[index + 1] : undefined;
};

const dumpPath = arg('--dump');
const url = arg('--url') ?? process.env.DATABASE_URL;
const wipe = process.argv.includes('--wipe');
if (!dumpPath || !url) {
	console.error(
		'Usage: d1-to-postgres.mjs --dump <d1.sql> --url <postgres url> [--wipe]'
	);
	process.exit(1);
}

const sqlite = new DatabaseSync(':memory:');
// D1 exports include the FTS virtual tables and their shadow tables, which
// node:sqlite may not be able to create. Skip anything mentioning them.
const skip = /files_fts|files_trgm|sqlite_sequence|_cf_KV|d1_migrations/i;
const statements = readFileSync(dumpPath, 'utf8')
	.split(/;\s*\n/)
	.map((statement) => statement.trim())
	.filter((statement) => statement && !skip.test(statement));
for (const statement of statements) sqlite.exec(`${statement};`);

const rows = (table) => sqlite.prepare(`SELECT * FROM ${table}`).all();
const bool = (value) => value === 1 || value === true;
const ts = (value) => (value == null ? null : new Date(value).toISOString());

const copy = async (client, table, columns, transform) => {
	const source = rows(table);
	let count = 0;
	for (const row of source) {
		const values = transform(row);
		const placeholders = columns.map((_, index) => `$${index + 1}`).join(', ');
		await client.query(
			`INSERT INTO ${table} (${columns.join(', ')}) VALUES (${placeholders}) ON CONFLICT DO NOTHING`,
			columns.map((column) => values[column])
		);
		count += 1;
	}
	console.log(`${table}: ${count}`);
};

const client = new Pg.Client({ connectionString: url });
await client.connect();
try {
	await client.query('BEGIN');
	if (wipe) {
		await client.query(
			'TRUNCATE files, tags, api_keys, device_codes, site_upload_sessions, pending_site_asset_deletes, instance_secrets CASCADE'
		);
	}
	await copy(
		client,
		'files',
		[
			'id',
			'display_name',
			'content_type',
			'kind',
			'current_version',
			'size_bytes',
			'public',
			'is_site',
			'created_at',
			'updated_at',
			'deleted_at',
			'purge_at',
			'purge_state',
			'purge_attempts',
			'purge_error',
			'purge_next_run_at',
			'expires_at',
			'download_count',
			'last_download_at',
			'index_state',
			'indexed_version',
			'index_cursor',
			'index_attempts',
			'index_error',
			'index_next_run_at',
			'index_lease_token'
		],
		(row) => ({
			...row,
			public: bool(row.public),
			is_site: bool(row.is_site),
			created_at: ts(row.created_at),
			updated_at: ts(row.updated_at),
			deleted_at: ts(row.deleted_at),
			purge_at: ts(row.purge_at),
			purge_next_run_at: ts(row.purge_next_run_at),
			expires_at: ts(row.expires_at),
			last_download_at: ts(row.last_download_at),
			// Vectors do not move; every file re-embeds through the queue.
			index_state: row.index_state === 'disabled' ? 'disabled' : 'pending',
			indexed_version: null,
			index_cursor: 0,
			index_attempts: 0,
			index_error: null,
			index_next_run_at: null,
			index_lease_token: null
		})
	);
	await copy(
		client,
		'file_versions',
		[
			'file_id',
			'version',
			'r2_key',
			'size_bytes',
			'sha256',
			'content_type',
			'created_at',
			'text_content',
			'thumbnail_r2_key',
			'thumbnail_size_bytes'
		],
		(row) => ({
			...row,
			created_at: ts(row.created_at),
			thumbnail_size_bytes: row.thumbnail_size_bytes ?? 0
		})
	);
	await copy(
		client,
		'tags',
		['id', 'name', 'normalized_name', 'color', 'created_at'],
		(row) => ({ ...row, created_at: ts(row.created_at) })
	);
	await copy(client, 'file_tags', ['file_id', 'tag_id'], (row) => row);
	await copy(
		client,
		'site_assets',
		['file_id', 'version', 'path', 'r2_key', 'content_type', 'size_bytes'],
		(row) => row
	);
	await copy(
		client,
		'api_keys',
		[
			'id',
			'name',
			'prefix',
			'secret_hash',
			'scope',
			'created_at',
			'expires_at',
			'last_used_at',
			'revoked_at'
		],
		(row) => ({
			...row,
			scope: row.scope ?? 'read-write',
			created_at: ts(row.created_at),
			expires_at: ts(row.expires_at),
			last_used_at: ts(row.last_used_at),
			revoked_at: ts(row.revoked_at)
		})
	);
	await copy(
		client,
		'pending_site_asset_deletes',
		['r2_key', 'file_id', 'version', 'queued_at', 'attempts', 'last_error'],
		(row) => ({ ...row, queued_at: ts(row.queued_at) })
	);
	await copy(
		client,
		'instance_secrets',
		['id', 'content_grant_signing_key', 'created_at'],
		(row) => ({ ...row, created_at: ts(row.created_at) })
	);
	// Sessions, device codes, and the passcode hash are not carried over;
	// everyone signs in again. Keyword search documents are rebuilt.
	await client.query(`
		INSERT INTO search_documents (file_id, chunk_no, name, tags, body)
		SELECT f.id, 0, f.display_name,
			COALESCE((SELECT string_agg(t.name, ' ' ORDER BY t.normalized_name)
				FROM file_tags ft JOIN tags t ON t.id = ft.tag_id WHERE ft.file_id = f.id), ''),
			left(COALESCE(v.text_content, ''), 65536)
		FROM files f JOIN file_versions v ON v.file_id = f.id AND v.version = f.current_version
		ON CONFLICT (file_id, chunk_no) DO NOTHING`);
	const summary = await client.query(
		`SELECT (SELECT count(*) FROM files) AS files, (SELECT count(*) FROM file_versions) AS versions,
			(SELECT count(*) FROM search_documents) AS documents`
	);
	console.log('postgres totals', summary.rows[0]);
	await client.query('COMMIT');
} catch (cause) {
	await client.query('ROLLBACK');
	throw cause;
} finally {
	await client.end();
}
