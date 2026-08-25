-- Durable private links: a revocable, optionally passworded share of a single
-- file that works on the cookie-less content origin. The 15-minute HMAC grant
-- stays as-is for dashboard previews; a share is the "open on my phone later"
-- or "send to one person" path. The token is stored hashed (prefix for lookup,
-- SHA-256 of the full secret); the plaintext token is shown once at creation.
-- A share follows the file's current version and stops resolving once the file
-- is trashed, expired, or the share is revoked or past expires_at.
CREATE TABLE file_shares (
	id TEXT PRIMARY KEY,
	file_id TEXT NOT NULL REFERENCES files(id) ON DELETE CASCADE,
	token_prefix TEXT NOT NULL UNIQUE,
	token_hash TEXT NOT NULL,
	password_hash TEXT,
	label TEXT,
	created_at TEXT NOT NULL,
	expires_at TEXT,
	last_accessed_at TEXT,
	revoked_at TEXT
);

CREATE INDEX file_shares_file_idx
	ON file_shares(file_id, revoked_at);
CREATE INDEX file_shares_expiry_idx
	ON file_shares(expires_at);
