PRAGMA foreign_keys = ON;

CREATE TABLE files (
	id TEXT PRIMARY KEY,
	display_name TEXT NOT NULL,
	content_type TEXT NOT NULL,
	kind TEXT NOT NULL DEFAULT 'file' CHECK (kind IN ('file', 'site')),
	current_version INTEGER NOT NULL DEFAULT 1 CHECK (current_version > 0),
	size_bytes INTEGER NOT NULL CHECK (size_bytes >= 0),
	public INTEGER NOT NULL DEFAULT 1 CHECK (public IN (0, 1)),
	is_site INTEGER NOT NULL DEFAULT 0 CHECK (is_site IN (0, 1)),
	created_at TEXT NOT NULL,
	updated_at TEXT NOT NULL,
	deleted_at TEXT,
	purge_at TEXT,
	purge_state TEXT NOT NULL DEFAULT 'none' CHECK (
		purge_state IN ('none', 'pending', 'done', 'failed')
	),
	expires_at TEXT,
	download_count INTEGER NOT NULL DEFAULT 0 CHECK (download_count >= 0),
	last_download_at TEXT,
	index_state TEXT NOT NULL DEFAULT 'pending' CHECK (
		index_state IN ('pending', 'running', 'ready', 'failed', 'disabled')
	),
	indexed_version INTEGER,
	index_cursor INTEGER NOT NULL DEFAULT 0 CHECK (index_cursor >= 0),
	index_attempts INTEGER NOT NULL DEFAULT 0 CHECK (index_attempts >= 0),
	index_error TEXT,
	index_next_run_at TEXT
);

CREATE TABLE file_versions (
	file_id TEXT NOT NULL REFERENCES files(id) ON DELETE CASCADE,
	version INTEGER NOT NULL CHECK (version > 0),
	r2_key TEXT NOT NULL UNIQUE,
	size_bytes INTEGER NOT NULL CHECK (size_bytes >= 0),
	sha256 TEXT,
	content_type TEXT NOT NULL,
	created_at TEXT NOT NULL,
	text_content TEXT,
	PRIMARY KEY (file_id, version)
);

CREATE TABLE tags (
	id TEXT PRIMARY KEY,
	name TEXT NOT NULL,
	normalized_name TEXT NOT NULL UNIQUE,
	color TEXT,
	created_at TEXT NOT NULL
);

CREATE TABLE file_tags (
	file_id TEXT NOT NULL REFERENCES files(id) ON DELETE CASCADE,
	tag_id TEXT NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
	PRIMARY KEY (file_id, tag_id)
);

CREATE TABLE site_assets (
	file_id TEXT NOT NULL REFERENCES files(id) ON DELETE CASCADE,
	version INTEGER NOT NULL,
	path TEXT NOT NULL,
	r2_key TEXT NOT NULL UNIQUE,
	content_type TEXT NOT NULL,
	size_bytes INTEGER NOT NULL CHECK (size_bytes >= 0),
	PRIMARY KEY (file_id, version, path)
);

CREATE TABLE file_chunks (
	vector_id TEXT PRIMARY KEY,
	file_id TEXT NOT NULL REFERENCES files(id) ON DELETE CASCADE,
	version INTEGER NOT NULL,
	ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
	char_start INTEGER NOT NULL CHECK (char_start >= 0),
	char_end INTEGER NOT NULL CHECK (char_end >= char_start)
);

CREATE TABLE pending_vector_deletes (
	vector_id TEXT PRIMARY KEY,
	queued_at TEXT NOT NULL
);

CREATE TABLE api_keys (
	id TEXT PRIMARY KEY,
	name TEXT NOT NULL,
	prefix TEXT NOT NULL UNIQUE,
	secret_hash TEXT NOT NULL,
	created_at TEXT NOT NULL,
	last_used_at TEXT,
	revoked_at TEXT
);

CREATE TABLE device_codes (
	device_code_hash TEXT PRIMARY KEY,
	user_code TEXT NOT NULL UNIQUE,
	status TEXT NOT NULL,
	interval_seconds INTEGER NOT NULL,
	expires_at TEXT NOT NULL,
	created_at TEXT NOT NULL
);

CREATE TABLE device_tokens (
	token_hash TEXT PRIMARY KEY,
	device_id TEXT NOT NULL,
	name TEXT NOT NULL,
	created_at TEXT NOT NULL,
	last_used_at TEXT,
	revoked_at TEXT
);

-- Reserved now so multipart can be added without changing existing file rows.
CREATE TABLE upload_sessions (
	id TEXT PRIMARY KEY,
	file_id TEXT NOT NULL,
	r2_key TEXT NOT NULL UNIQUE,
	display_name TEXT NOT NULL,
	content_type TEXT NOT NULL,
	public INTEGER NOT NULL CHECK (public IN (0, 1)),
	expected_size_bytes INTEGER NOT NULL CHECK (expected_size_bytes >= 0),
	part_size_bytes INTEGER NOT NULL CHECK (part_size_bytes > 0),
	r2_upload_id TEXT NOT NULL,
	status TEXT NOT NULL CHECK (status IN ('open', 'committing', 'complete', 'aborted')),
	created_at TEXT NOT NULL,
	expires_at TEXT NOT NULL
);

CREATE TABLE upload_parts (
	session_id TEXT NOT NULL REFERENCES upload_sessions(id) ON DELETE CASCADE,
	part_number INTEGER NOT NULL CHECK (part_number > 0),
	etag TEXT NOT NULL,
	size_bytes INTEGER NOT NULL CHECK (size_bytes >= 0),
	PRIMARY KEY (session_id, part_number)
);

CREATE INDEX files_active_updated_idx
	ON files(deleted_at, updated_at DESC);
CREATE INDEX file_versions_r2_key_idx
	ON file_versions(r2_key);
CREATE INDEX api_keys_prefix_active_idx
	ON api_keys(prefix, revoked_at);
CREATE INDEX upload_sessions_expiry_idx
	ON upload_sessions(status, expires_at);

