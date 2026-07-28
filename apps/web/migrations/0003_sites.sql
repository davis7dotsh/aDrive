CREATE TABLE site_upload_sessions (
	id TEXT PRIMARY KEY,
	file_id TEXT NOT NULL,
	display_name TEXT NOT NULL,
	version INTEGER NOT NULL CHECK (version > 0),
	status TEXT NOT NULL CHECK (
		status IN ('open', 'committing', 'complete', 'aborted')
	),
	created_at TEXT NOT NULL,
	expires_at TEXT NOT NULL
);

CREATE TABLE staged_site_assets (
	session_id TEXT NOT NULL REFERENCES site_upload_sessions(id) ON DELETE CASCADE,
	path TEXT NOT NULL,
	expected_size_bytes INTEGER NOT NULL CHECK (expected_size_bytes >= 0),
	content_type TEXT NOT NULL,
	r2_key TEXT UNIQUE,
	stored_size_bytes INTEGER CHECK (stored_size_bytes >= 0),
	uploaded_at TEXT,
	PRIMARY KEY (session_id, path),
	CHECK (
		(r2_key IS NULL AND stored_size_bytes IS NULL AND uploaded_at IS NULL)
		OR
		(r2_key IS NOT NULL AND stored_size_bytes IS NOT NULL AND uploaded_at IS NOT NULL)
	)
);

-- R2 cleanup is compensatable, while D1 is the serving authority. Rows remain
-- here after a failed delete and are retried by later site operations.
CREATE TABLE pending_site_asset_deletes (
	r2_key TEXT PRIMARY KEY,
	file_id TEXT NOT NULL,
	version INTEGER NOT NULL CHECK (version > 0),
	queued_at TEXT NOT NULL,
	attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
	last_error TEXT
);

CREATE INDEX site_upload_sessions_expiry_idx
	ON site_upload_sessions(status, expires_at);

CREATE INDEX pending_site_asset_deletes_file_idx
	ON pending_site_asset_deletes(file_id, queued_at);
