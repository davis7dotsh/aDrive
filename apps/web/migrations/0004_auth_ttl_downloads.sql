CREATE TABLE dashboard_sessions (
	token_hash TEXT PRIMARY KEY,
	created_at TEXT NOT NULL,
	expires_at TEXT NOT NULL,
	last_used_at TEXT NOT NULL
);

CREATE INDEX dashboard_sessions_expiry_idx
	ON dashboard_sessions(expires_at);

ALTER TABLE device_codes ADD COLUMN name TEXT NOT NULL DEFAULT 'adrive CLI';
ALTER TABLE device_codes ADD COLUMN last_polled_at TEXT;
ALTER TABLE device_codes ADD COLUMN approved_at TEXT;
ALTER TABLE device_codes ADD COLUMN consumed_at TEXT;
ALTER TABLE device_codes ADD COLUMN api_key_id TEXT REFERENCES api_keys(id);

CREATE INDEX device_codes_expiry_status_idx
	ON device_codes(status, expires_at);

CREATE INDEX files_expiry_idx
	ON files(expires_at, deleted_at);
