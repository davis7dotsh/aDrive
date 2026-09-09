// One-off data move from the D1 export of a single-tenant adrive instance
// into Postgres. `wrangler d1 export` refuses databases that contain FTS5
// virtual tables, so export one table at a time into a directory:
//
//   for t in files file_versions tags file_tags site_assets api_keys \
//            pending_site_asset_deletes instance_secrets \
//            site_upload_sessions staged_site_assets; do
//     wrangler d1 export DB --env production --remote --table $t --output d1/$t.sql
//   done
//
// Each file is replayed into an in-memory SQLite database, then copied row
// by row with type conversion (0/1 -> boolean, ISO text -> timestamptz).
//
//   bun apps/web/scripts/d1-to-postgres.mjs --dump d1/ --url postgres://... \
//     --org org_01ABC --user user_01ABC --email you@example.com [--slug you]
//   ... --wipe   # truncate first
//
// The target is multi-tenant, so the import needs the WorkOS org and user
// ids the drive's owner signed up with (sign in once on the hosted app
// first, then read them from the orgs/users tables or the WorkOS
// dashboard). Every copied row lands in that org.
//
// R2 objects do not move. Keyword search documents are rebuilt from the
// copied rows; semantic vectors are not carried over (Vectorize is gone),
// so every file is left in index_state = 'pending' for the queue/cron to
// re-embed.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { constants, DatabaseSync } from 'node:sqlite';
import Pg from 'pg';

const arg = (flag) => {
	const index = process.argv.indexOf(flag);
	return index >= 0 ? process.argv[index + 1] : undefined;
};

const dumpPath = arg('--dump');
const url = arg('--url') ?? process.env.DATABASE_URL;
const wipe = process.argv.includes('--wipe');
const orgId = arg('--org');
const userId = arg('--user');
const email = arg('--email');
if (!dumpPath || !url || !orgId || !userId || !email) {
	console.error(
		'Usage: d1-to-postgres.mjs --dump <d1.sql> --url <postgres url> --org <org id> --user <user id> --email <email> [--slug <slug>] [--wipe]'
	);
	process.exit(1);
}
const slug =
	arg('--slug') ??
	email
		.split('@')[0]
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, '-')
		.replace(/^-|-$/g, '');

const sqlite = new DatabaseSync(':memory:', {
	enableForeignKeyConstraints: false
});
const dumpFiles = statSync(dumpPath).isDirectory()
	? readdirSync(dumpPath)
			.filter((name) => name.endsWith('.sql'))
			.sort()
			.map((name) => join(dumpPath, name))
	: [dumpPath];
// Let SQLite parse the complete exports, including multiline SQL literals.
// Foreign keys stay disabled while files referring to each other replay.
// Ignore actual export PRAGMAs through SQLite's parser, not text matching.
sqlite.setAuthorizer((action) =>
	action === constants.SQLITE_PRAGMA
		? constants.SQLITE_IGNORE
		: constants.SQLITE_OK
);
for (const file of dumpFiles) {
	sqlite.exec(readFileSync(file, 'utf8'));
}
sqlite.setAuthorizer(null);
const tableExists = (table) =>
	sqlite
		.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?")
		.get(table) !== undefined;
const missingTables = [
	'files',
	'file_versions',
	'tags',
	'file_tags',
	'site_assets',
	'api_keys',
	'pending_site_asset_deletes',
	'instance_secrets',
	'site_upload_sessions',
	'staged_site_assets'
].filter((table) => !tableExists(table));
if (missingTables.length > 0) {
	sqlite.close();
	throw new Error(
		`D1 export is missing required tables: ${missingTables.join(', ')}`
	);
}

const rows = (table) => sqlite.prepare(`SELECT * FROM ${table}`).all();
// Staging is not resumed after cutover, but its stored objects still need
// cleanup ownership. Never enqueue an object referenced by published assets.
const storedStagedAssets = sqlite
	.prepare(
		`
	SELECT a.r2_key, s.file_id, s.version,
		EXISTS (SELECT 1 FROM site_assets live WHERE live.r2_key = a.r2_key) AS is_live
	FROM staged_site_assets a
	LEFT JOIN site_upload_sessions s ON s.id = a.session_id
	WHERE a.r2_key IS NOT NULL
`
	)
	.all();
if (
	storedStagedAssets.some(
		(asset) => asset.file_id == null || asset.version == null
	)
) {
	sqlite.close();
	throw new Error(
		'D1 export contains stored staged assets without their upload sessions'
	);
}
const stagedCleanup = storedStagedAssets.filter((asset) => asset.is_live === 0);
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
			'TRUNCATE files, tags, api_keys, device_codes, dashboard_sessions, credential_state, site_upload_sessions, pending_site_asset_deletes, instance_secrets CASCADE'
		);
	}
	await client.query(
		`INSERT INTO orgs (id, slug, name) VALUES ($1, $2, $3) ON CONFLICT (id) DO NOTHING`,
		[orgId, slug, `${slug}'s drive`]
	);
	await client.query(
		`INSERT INTO users (id, email, email_verified) VALUES ($1, $2, true) ON CONFLICT (id) DO NOTHING`,
		[userId, email]
	);
	await client.query(
		`INSERT INTO memberships (org_id, user_id, role) VALUES ($1, $2, 'owner') ON CONFLICT DO NOTHING`,
		[orgId, userId]
	);
	await client.query(
		`INSERT INTO org_usage (org_id) VALUES ($1) ON CONFLICT DO NOTHING`,
		[orgId]
	);
	await copy(
		client,
		'files',
		[
			'id',
			'org_id',
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
			org_id: orgId,
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
			'org_id',
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
			org_id: orgId,
			created_at: ts(row.created_at),
			text_content:
				row.text_content == null
					? null
					: row.text_content.replaceAll('\u0000', ''),
			thumbnail_size_bytes: row.thumbnail_size_bytes ?? 0
		})
	);
	await copy(
		client,
		'tags',
		['id', 'org_id', 'name', 'normalized_name', 'color', 'created_at'],
		(row) => ({ ...row, org_id: orgId, created_at: ts(row.created_at) })
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
			'org_id',
			'user_id',
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
			org_id: orgId,
			user_id: userId,
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
	const queuedAt = new Date().toISOString();
	let queuedStagedAssets = 0;
	for (const asset of stagedCleanup) {
		const queued = await client.query(
			`INSERT INTO pending_site_asset_deletes (r2_key, file_id, version, queued_at)
			 SELECT $1, $2, $3, $4
			 WHERE NOT EXISTS (SELECT 1 FROM site_assets WHERE r2_key = $1)
			 ON CONFLICT (r2_key) DO NOTHING
			 RETURNING r2_key`,
			[asset.r2_key, asset.file_id, asset.version, queuedAt]
		);
		queuedStagedAssets += queued.rowCount;
	}
	console.log(`staged_site_assets queued for cleanup: ${queuedStagedAssets}`);
	// The org's stored-byte counter is derived from what was copied.
	await client.query(
		`UPDATE org_usage u SET stored_bytes = COALESCE((
			SELECT SUM(CASE
				WHEN f.is_site THEN f.size_bytes
				ELSE (SELECT COALESCE(SUM(v.size_bytes + v.thumbnail_size_bytes), 0)
					FROM file_versions v WHERE v.file_id = f.id)
			END)
			FROM files f WHERE f.org_id = u.org_id
		), 0) WHERE u.org_id = $1`,
		[orgId]
	);

	// Sessions, device codes, and the passcode hash are not carried over;
	// everyone signs in again. Keyword search documents are rebuilt.
	await client.query(`
		INSERT INTO search_documents (file_id, org_id, chunk_no, name, tags, body)
		SELECT f.id, f.org_id, 0, f.display_name,
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
	sqlite.close();
}
