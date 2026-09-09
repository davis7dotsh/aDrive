-- migrate:up
-- Port of the D1 schema (migrations 0001 through 0010) to Postgres, in its
-- end-of-stack-A shape: real booleans and timestamps, keyword search in
-- search_documents (tsvector + pg_trgm), semantic vectors on file_chunks
-- (pgvector). Tables that the app never used (device_tokens,
-- upload_sessions, upload_parts, pending_vector_deletes) are not carried
-- over.

CREATE TABLE files (
	id text PRIMARY KEY,
	display_name text NOT NULL,
	content_type text NOT NULL,
	kind text NOT NULL DEFAULT 'file' CHECK (kind IN ('file', 'site')),
	current_version integer NOT NULL DEFAULT 1 CHECK (current_version > 0),
	size_bytes bigint NOT NULL CHECK (size_bytes >= 0),
	public boolean NOT NULL DEFAULT true,
	is_site boolean NOT NULL DEFAULT false,
	created_at timestamptz NOT NULL,
	updated_at timestamptz NOT NULL,
	deleted_at timestamptz,
	purge_at timestamptz,
	purge_state text NOT NULL DEFAULT 'none' CHECK (
		purge_state IN ('none', 'pending', 'done', 'failed')
	),
	purge_attempts integer NOT NULL DEFAULT 0 CHECK (purge_attempts >= 0),
	purge_error text,
	purge_next_run_at timestamptz,
	expires_at timestamptz,
	download_count integer NOT NULL DEFAULT 0 CHECK (download_count >= 0),
	last_download_at timestamptz,
	index_state text NOT NULL DEFAULT 'pending' CHECK (
		index_state IN ('pending', 'running', 'ready', 'failed', 'disabled')
	),
	indexed_version integer,
	index_cursor integer NOT NULL DEFAULT 0 CHECK (index_cursor >= 0),
	index_attempts integer NOT NULL DEFAULT 0 CHECK (index_attempts >= 0),
	index_error text,
	index_next_run_at timestamptz,
	index_lease_token text
);

CREATE INDEX files_active_updated_idx ON files (deleted_at, updated_at DESC);
CREATE INDEX files_expiry_idx ON files (expires_at, deleted_at);
CREATE INDEX files_index_jobs_idx ON files (index_state, index_next_run_at, updated_at);
CREATE INDEX files_purge_jobs_idx ON files (purge_state, purge_next_run_at, purge_at, expires_at);

CREATE TABLE file_versions (
	file_id text NOT NULL REFERENCES files (id) ON DELETE CASCADE,
	version integer NOT NULL CHECK (version > 0),
	r2_key text NOT NULL UNIQUE,
	size_bytes bigint NOT NULL CHECK (size_bytes >= 0),
	sha256 text,
	content_type text NOT NULL,
	created_at timestamptz NOT NULL,
	text_content text,
	thumbnail_r2_key text,
	thumbnail_size_bytes bigint NOT NULL DEFAULT 0 CHECK (thumbnail_size_bytes >= 0),
	PRIMARY KEY (file_id, version)
);

CREATE TABLE tags (
	id text PRIMARY KEY,
	name text NOT NULL,
	normalized_name text NOT NULL UNIQUE,
	color text,
	created_at timestamptz NOT NULL
);

CREATE TABLE file_tags (
	file_id text NOT NULL REFERENCES files (id) ON DELETE CASCADE,
	tag_id text NOT NULL REFERENCES tags (id) ON DELETE CASCADE,
	PRIMARY KEY (file_id, tag_id)
);

CREATE INDEX file_tags_tag_idx ON file_tags (tag_id, file_id);

CREATE TABLE site_assets (
	file_id text NOT NULL REFERENCES files (id) ON DELETE CASCADE,
	version integer NOT NULL,
	path text NOT NULL,
	r2_key text NOT NULL UNIQUE,
	content_type text NOT NULL,
	size_bytes bigint NOT NULL CHECK (size_bytes >= 0),
	PRIMARY KEY (file_id, version, path)
);

-- One row per embedded chunk. Deleting the file row deletes its vectors,
-- which replaces the pending_vector_deletes retry table from D1.
CREATE TABLE file_chunks (
	file_id text NOT NULL REFERENCES files (id) ON DELETE CASCADE,
	version integer NOT NULL,
	ordinal integer NOT NULL CHECK (ordinal >= 0),
	char_start integer NOT NULL CHECK (char_start >= 0),
	char_end integer NOT NULL CHECK (char_end >= char_start),
	embedding vector(384),
	PRIMARY KEY (file_id, version, ordinal)
);

CREATE INDEX file_chunks_embedding_idx
	ON file_chunks USING hnsw (embedding vector_cosine_ops);

-- Keyword search. One row per file (chunk_no 0) today; chunk_no exists so
-- long documents can be split later without a schema change.
CREATE TABLE search_documents (
	file_id text NOT NULL REFERENCES files (id) ON DELETE CASCADE,
	chunk_no integer NOT NULL DEFAULT 0 CHECK (chunk_no >= 0),
	name text NOT NULL,
	tags text NOT NULL DEFAULT '',
	body text NOT NULL DEFAULT '',
	tsv tsvector GENERATED ALWAYS AS (
		setweight(to_tsvector('simple', name), 'A')
		|| setweight(to_tsvector('simple', tags), 'B')
		|| setweight(to_tsvector('english', body), 'C')
	) STORED,
	PRIMARY KEY (file_id, chunk_no)
);

CREATE INDEX search_documents_tsv_idx ON search_documents USING gin (tsv);
CREATE INDEX search_documents_name_trgm_idx
	ON search_documents USING gin (name gin_trgm_ops)
	WHERE chunk_no = 0;

CREATE TABLE api_keys (
	id text PRIMARY KEY,
	name text NOT NULL,
	prefix text NOT NULL UNIQUE,
	secret_hash text NOT NULL,
	scope text NOT NULL DEFAULT 'read-write' CHECK (scope IN ('read-only', 'read-write')),
	created_at timestamptz NOT NULL,
	expires_at timestamptz,
	last_used_at timestamptz,
	revoked_at timestamptz
);

CREATE INDEX api_keys_prefix_active_idx ON api_keys (prefix, revoked_at);

CREATE TABLE device_codes (
	device_code_hash text PRIMARY KEY,
	user_code text NOT NULL UNIQUE,
	status text NOT NULL,
	interval_seconds integer NOT NULL,
	name text NOT NULL DEFAULT 'adrive CLI',
	expires_at timestamptz NOT NULL,
	created_at timestamptz NOT NULL,
	last_polled_at timestamptz,
	approved_at timestamptz,
	consumed_at timestamptz,
	api_key_id text REFERENCES api_keys (id)
);

CREATE INDEX device_codes_expiry_status_idx ON device_codes (status, expires_at);

CREATE TABLE dashboard_sessions (
	token_hash text PRIMARY KEY,
	created_at timestamptz NOT NULL,
	expires_at timestamptz NOT NULL,
	last_used_at timestamptz NOT NULL
);

CREATE INDEX dashboard_sessions_expiry_idx ON dashboard_sessions (expires_at);

CREATE TABLE site_upload_sessions (
	id text PRIMARY KEY,
	file_id text NOT NULL,
	display_name text NOT NULL,
	version integer NOT NULL CHECK (version > 0),
	status text NOT NULL CHECK (
		status IN ('open', 'committing', 'complete', 'aborted')
	),
	created_at timestamptz NOT NULL,
	expires_at timestamptz NOT NULL
);

CREATE INDEX site_upload_sessions_expiry_idx ON site_upload_sessions (status, expires_at);

CREATE TABLE staged_site_assets (
	session_id text NOT NULL REFERENCES site_upload_sessions (id) ON DELETE CASCADE,
	path text NOT NULL,
	expected_size_bytes bigint NOT NULL CHECK (expected_size_bytes >= 0),
	content_type text NOT NULL,
	r2_key text UNIQUE,
	stored_size_bytes bigint CHECK (stored_size_bytes >= 0),
	uploaded_at timestamptz,
	PRIMARY KEY (session_id, path),
	CHECK (
		(r2_key IS NULL AND stored_size_bytes IS NULL AND uploaded_at IS NULL)
		OR
		(r2_key IS NOT NULL AND stored_size_bytes IS NOT NULL AND uploaded_at IS NOT NULL)
	)
);

-- R2 cleanup is compensatable while Postgres is the serving authority.
-- Rows remain after a failed delete and are retried by later sweeps.
CREATE TABLE pending_site_asset_deletes (
	r2_key text PRIMARY KEY,
	file_id text NOT NULL,
	version integer NOT NULL CHECK (version > 0),
	queued_at timestamptz NOT NULL,
	attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
	last_error text
);

CREATE INDEX pending_site_asset_deletes_file_idx
	ON pending_site_asset_deletes (file_id, queued_at);

CREATE TABLE instance_secrets (
	id integer PRIMARY KEY CHECK (id = 1),
	content_grant_signing_key text NOT NULL CHECK (
		length(content_grant_signing_key) = 43
		AND content_grant_signing_key ~ '^[A-Za-z0-9_-]+$'
	),
	created_at timestamptz NOT NULL
);

CREATE TABLE credential_state (
	id integer PRIMARY KEY CHECK (id = 1),
	passcode_hash text NOT NULL CHECK (length(passcode_hash) = 64),
	rotated_at timestamptz NOT NULL
);

-- migrate:down
DROP TABLE IF EXISTS credential_state;
DROP TABLE IF EXISTS instance_secrets;
DROP TABLE IF EXISTS pending_site_asset_deletes;
DROP TABLE IF EXISTS staged_site_assets;
DROP TABLE IF EXISTS site_upload_sessions;
DROP TABLE IF EXISTS dashboard_sessions;
DROP TABLE IF EXISTS device_codes;
DROP TABLE IF EXISTS api_keys;
DROP TABLE IF EXISTS search_documents;
DROP TABLE IF EXISTS file_chunks;
DROP TABLE IF EXISTS site_assets;
DROP TABLE IF EXISTS file_tags;
DROP TABLE IF EXISTS tags;
DROP TABLE IF EXISTS file_versions;
DROP TABLE IF EXISTS files;
