-- Read-only keys can list and download but not mutate; expiry is optional
-- and enforced at authorization time. Existing keys keep full access.
ALTER TABLE api_keys ADD COLUMN scope TEXT NOT NULL DEFAULT 'read-write'
	CHECK (scope IN ('read-only', 'read-write'));
ALTER TABLE api_keys ADD COLUMN expires_at TEXT;
