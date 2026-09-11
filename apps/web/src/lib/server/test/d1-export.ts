import { appendFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

// Canonical tables from the final D1 schema, exported in separate files.
const schemas = {
	files: `CREATE TABLE files (
		id TEXT PRIMARY KEY, display_name TEXT NOT NULL, content_type TEXT NOT NULL,
		kind TEXT DEFAULT 'file', current_version INTEGER DEFAULT 1,
		size_bytes INTEGER DEFAULT 12, public INTEGER DEFAULT 1, is_site INTEGER DEFAULT 0,
		created_at TEXT, updated_at TEXT, deleted_at TEXT, purge_at TEXT,
		purge_state TEXT DEFAULT 'none', purge_attempts INTEGER DEFAULT 0,
		purge_error TEXT, purge_next_run_at TEXT, expires_at TEXT,
		download_count INTEGER DEFAULT 0, last_download_at TEXT,
		index_state TEXT DEFAULT 'ready', indexed_version INTEGER DEFAULT 1,
		index_cursor INTEGER DEFAULT 2, index_attempts INTEGER DEFAULT 3,
		index_error TEXT, index_next_run_at TEXT, index_lease_token TEXT
	);`,
	file_versions: `CREATE TABLE file_versions (
		file_id TEXT REFERENCES files(id) ON DELETE CASCADE, version INTEGER,
		r2_key TEXT, size_bytes INTEGER, sha256 TEXT, content_type TEXT,
		created_at TEXT, text_content TEXT, thumbnail_r2_key TEXT,
		thumbnail_size_bytes INTEGER DEFAULT 0,
		PRIMARY KEY (file_id, version)
	);`,
	tags: `CREATE TABLE tags (
		id TEXT PRIMARY KEY, name TEXT, normalized_name TEXT, color TEXT, created_at TEXT
	);`,
	file_tags: `CREATE TABLE file_tags (
		file_id TEXT REFERENCES files(id) ON DELETE CASCADE,
		tag_id TEXT REFERENCES tags(id) ON DELETE CASCADE,
		PRIMARY KEY (file_id, tag_id)
	);`,
	site_assets: `CREATE TABLE site_assets (
		file_id TEXT REFERENCES files(id) ON DELETE CASCADE, version INTEGER,
		path TEXT, r2_key TEXT, content_type TEXT, size_bytes INTEGER,
		PRIMARY KEY (file_id, version, path)
	);`,
	api_keys: `CREATE TABLE api_keys (
		id TEXT PRIMARY KEY, name TEXT, prefix TEXT, secret_hash TEXT, scope TEXT,
		created_at TEXT, expires_at TEXT, last_used_at TEXT, revoked_at TEXT
	);`,
	pending_site_asset_deletes: `CREATE TABLE pending_site_asset_deletes (
		r2_key TEXT PRIMARY KEY, file_id TEXT, version INTEGER, queued_at TEXT,
		attempts INTEGER, last_error TEXT
	);`,
	instance_secrets: `CREATE TABLE instance_secrets (
		id INTEGER PRIMARY KEY, content_grant_signing_key TEXT, created_at TEXT
	);`,
	site_upload_sessions: `CREATE TABLE site_upload_sessions (
		id TEXT PRIMARY KEY, file_id TEXT, display_name TEXT, version INTEGER,
		status TEXT, created_at TEXT, expires_at TEXT
	);`,
	staged_site_assets: `CREATE TABLE staged_site_assets (
		session_id TEXT REFERENCES site_upload_sessions(id) ON DELETE CASCADE,
		path TEXT, expected_size_bytes INTEGER, content_type TEXT, r2_key TEXT,
		stored_size_bytes INTEGER, uploaded_at TEXT,
		PRIMARY KEY (session_id, path)
	);`
};

export const createD1Export = (directory: string) => {
	for (const [table, schema] of Object.entries(schemas)) {
		writeFileSync(
			join(directory, `${table}.sql`),
			`PRAGMA foreign_keys=ON;\nPRAGMA defer_foreign_keys=TRUE;\n${schema}\n`
		);
	}
	return {
		insert: (
			table: keyof typeof schemas,
			values: Record<string, string | number | null>
		) => {
			const literals = Object.values(values).map((value) =>
				typeof value === 'string'
					? value.includes('\u0000')
						? `CAST(X'${Buffer.from(value).toString('hex')}' AS TEXT)`
						: `'${value.replaceAll("'", "''")}'`
					: value === null
						? 'NULL'
						: String(value)
			);
			appendFileSync(
				join(directory, `${table}.sql`),
				`INSERT INTO ${table} (${Object.keys(values).join(', ')}) VALUES (${literals.join(', ')});\n`
			);
		}
	};
};
