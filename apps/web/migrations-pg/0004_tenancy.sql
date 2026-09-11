-- migrate:up
-- Tenancy. Every tenant row carries org_id; users sign in through WorkOS
-- and land in a personal org. This migration runs against a fresh
-- database (the one-off import from the old drive creates its org first,
-- then copies rows), so the org_id columns are added NOT NULL directly
-- with no backfill. Existing single-tenant databases stay untouched;
-- provision a separate target and follow docs/release.md for cutover.
--
-- Row level security is the second line of defence, never the first.
-- Every query carries its own `org_id = $1` predicate. Inside a
-- transaction the app additionally runs
-- `SELECT set_config('app.current_org', $1, true)` and the policies below
-- refuse rows from any other org. Outside a transaction the setting is
-- absent (Hyperdrive pools in transaction mode, so session settings are
-- not reliable) and the policies allow the row: those statements rely on
-- their WHERE clause alone. The docker development role is a superuser
-- and bypasses RLS entirely. Production uses a restricted runtime login
-- granted the NOLOGIN adrive_app role; migration credentials stay separate.

-- Block writes while checking so even a newly created session cannot be
-- lost between the empty-target check and the authentication table drops.
LOCK TABLE files, file_versions, file_chunks, search_documents, tags,
	file_tags, site_assets, api_keys, device_codes, dashboard_sessions,
	site_upload_sessions, staged_site_assets, pending_site_asset_deletes,
	instance_secrets, credential_state IN ACCESS EXCLUSIVE MODE;

DO $$
BEGIN
	IF EXISTS (SELECT 1 FROM files)
		OR EXISTS (SELECT 1 FROM file_versions)
		OR EXISTS (SELECT 1 FROM file_chunks)
		OR EXISTS (SELECT 1 FROM search_documents)
		OR EXISTS (SELECT 1 FROM tags)
		OR EXISTS (SELECT 1 FROM file_tags)
		OR EXISTS (SELECT 1 FROM site_assets)
		OR EXISTS (SELECT 1 FROM api_keys)
		OR EXISTS (SELECT 1 FROM device_codes)
		OR EXISTS (SELECT 1 FROM dashboard_sessions)
		OR EXISTS (SELECT 1 FROM site_upload_sessions)
		OR EXISTS (SELECT 1 FROM staged_site_assets)
		OR EXISTS (SELECT 1 FROM pending_site_asset_deletes)
		OR EXISTS (SELECT 1 FROM instance_secrets)
		OR EXISTS (SELECT 1 FROM credential_state)
	THEN
		RAISE EXCEPTION 'Tenancy bootstrap requires an empty target database'
			USING ERRCODE = '55000',
			HINT = 'Keep the existing drive database. Create a separate hosted target, then follow the supported import and cutover procedure in docs/release.md. Do not use --reset on existing drive data.';
	END IF;
END $$;

CREATE TABLE orgs (
	id text PRIMARY KEY,
	slug text NOT NULL UNIQUE,
	name text NOT NULL,
	trust text NOT NULL DEFAULT 'new' CHECK (
		trust IN ('new', 'verified', 'established', 'suspended')
	),
	plan text NOT NULL DEFAULT 'free',
	created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE users (
	id text PRIMARY KEY,
	email text NOT NULL,
	email_verified boolean NOT NULL DEFAULT false,
	created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE memberships (
	org_id text NOT NULL REFERENCES orgs (id) ON DELETE CASCADE,
	user_id text NOT NULL REFERENCES users (id) ON DELETE CASCADE,
	role text NOT NULL DEFAULT 'owner',
	PRIMARY KEY (org_id, user_id)
);

CREATE INDEX memberships_user_idx ON memberships (user_id);

CREATE TABLE org_usage (
	org_id text PRIMARY KEY REFERENCES orgs (id) ON DELETE CASCADE,
	stored_bytes bigint NOT NULL DEFAULT 0 CHECK (stored_bytes >= 0),
	file_count integer NOT NULL DEFAULT 0 CHECK (file_count >= 0)
);

-- WorkOS sessions replace the passcode session table and its rotation
-- record; nothing is carried over.
DROP TABLE dashboard_sessions;
DROP TABLE credential_state;

ALTER TABLE files ADD COLUMN org_id text NOT NULL REFERENCES orgs (id);
ALTER TABLE file_versions ADD COLUMN org_id text NOT NULL REFERENCES orgs (id);
ALTER TABLE file_chunks ADD COLUMN org_id text NOT NULL REFERENCES orgs (id);
ALTER TABLE search_documents ADD COLUMN org_id text NOT NULL REFERENCES orgs (id);
ALTER TABLE tags ADD COLUMN org_id text NOT NULL REFERENCES orgs (id);
ALTER TABLE api_keys ADD COLUMN org_id text NOT NULL REFERENCES orgs (id);
ALTER TABLE api_keys ADD COLUMN user_id text NOT NULL REFERENCES users (id);
ALTER TABLE site_upload_sessions ADD COLUMN org_id text NOT NULL REFERENCES orgs (id);

-- A device code is created by the CLI before anyone is signed in, so it
-- has no org until the dashboard approves it; approval stamps both
-- columns and the minted key copies them.
ALTER TABLE device_codes ADD COLUMN org_id text REFERENCES orgs (id);
ALTER TABLE device_codes ADD COLUMN user_id text REFERENCES users (id);

ALTER TABLE tags DROP CONSTRAINT tags_normalized_name_key;
ALTER TABLE tags ADD CONSTRAINT tags_org_normalized_name_key
	UNIQUE (org_id, normalized_name);

CREATE INDEX files_org_active_updated_idx
	ON files (org_id, deleted_at, updated_at DESC);
CREATE INDEX tags_org_idx ON tags (org_id);
CREATE INDEX api_keys_org_idx ON api_keys (org_id);
CREATE INDEX search_documents_org_idx ON search_documents (org_id);
CREATE INDEX file_chunks_org_idx ON file_chunks (org_id);

-- True when no org is pinned on the transaction (plain statements rely on
-- their WHERE clause) or when the row belongs to the pinned org.
CREATE OR REPLACE FUNCTION app_org_visible(row_org text)
	RETURNS boolean
	LANGUAGE sql
	STABLE
	PARALLEL SAFE
AS $$
	SELECT NULLIF(current_setting('app.current_org', true), '') IS NULL
		OR row_org = current_setting('app.current_org', true)
$$;

ALTER TABLE files ENABLE ROW LEVEL SECURITY;
ALTER TABLE files FORCE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON files USING (app_org_visible(org_id));

ALTER TABLE file_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE file_versions FORCE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON file_versions USING (app_org_visible(org_id));

ALTER TABLE file_chunks ENABLE ROW LEVEL SECURITY;
ALTER TABLE file_chunks FORCE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON file_chunks USING (app_org_visible(org_id));

ALTER TABLE search_documents ENABLE ROW LEVEL SECURITY;
ALTER TABLE search_documents FORCE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON search_documents
	USING (app_org_visible(org_id));

ALTER TABLE tags ENABLE ROW LEVEL SECURITY;
ALTER TABLE tags FORCE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON tags USING (app_org_visible(org_id));

ALTER TABLE api_keys ENABLE ROW LEVEL SECURITY;
ALTER TABLE api_keys FORCE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON api_keys USING (app_org_visible(org_id));

ALTER TABLE device_codes ENABLE ROW LEVEL SECURITY;
ALTER TABLE device_codes FORCE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON device_codes
	USING (org_id IS NULL OR app_org_visible(org_id));

ALTER TABLE site_upload_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE site_upload_sessions FORCE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON site_upload_sessions
	USING (app_org_visible(org_id));

ALTER TABLE file_tags ENABLE ROW LEVEL SECURITY;
ALTER TABLE file_tags FORCE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON file_tags USING (
	EXISTS (
		SELECT 1 FROM files f
		WHERE f.id = file_tags.file_id AND app_org_visible(f.org_id)
	)
);

ALTER TABLE site_assets ENABLE ROW LEVEL SECURITY;
ALTER TABLE site_assets FORCE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON site_assets USING (
	EXISTS (
		SELECT 1 FROM files f
		WHERE f.id = site_assets.file_id AND app_org_visible(f.org_id)
	)
);

ALTER TABLE staged_site_assets ENABLE ROW LEVEL SECURITY;
ALTER TABLE staged_site_assets FORCE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON staged_site_assets USING (
	EXISTS (
		SELECT 1 FROM site_upload_sessions s
		WHERE s.id = staged_site_assets.session_id AND app_org_visible(s.org_id)
	)
);

-- The application role. Managed Postgres providers may withhold CREATE
-- ROLE from the migration user; that is logged, not fatal, so the schema
-- still lands and the role is created by hand.
DO $$
BEGIN
	IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'adrive_app') THEN
		BEGIN
			CREATE ROLE adrive_app NOLOGIN;
		EXCEPTION WHEN insufficient_privilege THEN
			RAISE NOTICE 'adrive_app role not created: insufficient privilege';
		END;
	END IF;
	IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'adrive_app') THEN
		GRANT USAGE ON SCHEMA public TO adrive_app;
		GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public
			TO adrive_app;
		ALTER DEFAULT PRIVILEGES IN SCHEMA public
			GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO adrive_app;
	END IF;
END $$;

-- migrate:down
DROP POLICY IF EXISTS org_isolation ON staged_site_assets;
DROP POLICY IF EXISTS org_isolation ON site_assets;
DROP POLICY IF EXISTS org_isolation ON file_tags;
DROP POLICY IF EXISTS org_isolation ON site_upload_sessions;
DROP POLICY IF EXISTS org_isolation ON device_codes;
DROP POLICY IF EXISTS org_isolation ON api_keys;
DROP POLICY IF EXISTS org_isolation ON tags;
DROP POLICY IF EXISTS org_isolation ON search_documents;
DROP POLICY IF EXISTS org_isolation ON file_chunks;
DROP POLICY IF EXISTS org_isolation ON file_versions;
DROP POLICY IF EXISTS org_isolation ON files;
ALTER TABLE staged_site_assets DISABLE ROW LEVEL SECURITY;
ALTER TABLE site_assets DISABLE ROW LEVEL SECURITY;
ALTER TABLE file_tags DISABLE ROW LEVEL SECURITY;
ALTER TABLE site_upload_sessions DISABLE ROW LEVEL SECURITY;
ALTER TABLE device_codes DISABLE ROW LEVEL SECURITY;
ALTER TABLE api_keys DISABLE ROW LEVEL SECURITY;
ALTER TABLE tags DISABLE ROW LEVEL SECURITY;
ALTER TABLE search_documents DISABLE ROW LEVEL SECURITY;
ALTER TABLE file_chunks DISABLE ROW LEVEL SECURITY;
ALTER TABLE file_versions DISABLE ROW LEVEL SECURITY;
ALTER TABLE files DISABLE ROW LEVEL SECURITY;
DROP FUNCTION IF EXISTS app_org_visible(text);
DROP INDEX IF EXISTS file_chunks_org_idx;
DROP INDEX IF EXISTS search_documents_org_idx;
DROP INDEX IF EXISTS api_keys_org_idx;
DROP INDEX IF EXISTS tags_org_idx;
DROP INDEX IF EXISTS files_org_active_updated_idx;
ALTER TABLE tags DROP CONSTRAINT tags_org_normalized_name_key;
ALTER TABLE tags ADD CONSTRAINT tags_normalized_name_key UNIQUE (normalized_name);
ALTER TABLE device_codes DROP COLUMN user_id;
ALTER TABLE device_codes DROP COLUMN org_id;
ALTER TABLE site_upload_sessions DROP COLUMN org_id;
ALTER TABLE api_keys DROP COLUMN user_id;
ALTER TABLE api_keys DROP COLUMN org_id;
ALTER TABLE tags DROP COLUMN org_id;
ALTER TABLE search_documents DROP COLUMN org_id;
ALTER TABLE file_chunks DROP COLUMN org_id;
ALTER TABLE file_versions DROP COLUMN org_id;
ALTER TABLE files DROP COLUMN org_id;
DROP TABLE IF EXISTS org_usage;
DROP TABLE IF EXISTS memberships;
DROP TABLE IF EXISTS users;
DROP TABLE IF EXISTS orgs;
CREATE TABLE credential_state (
	id integer PRIMARY KEY CHECK (id = 1),
	passcode_hash text NOT NULL CHECK (length(passcode_hash) = 64),
	rotated_at timestamptz NOT NULL
);
CREATE TABLE dashboard_sessions (
	token_hash text PRIMARY KEY,
	created_at timestamptz NOT NULL,
	expires_at timestamptz NOT NULL,
	last_used_at timestamptz NOT NULL
);
CREATE INDEX dashboard_sessions_expiry_idx ON dashboard_sessions (expires_at);
