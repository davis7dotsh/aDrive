-- migrate:up
-- Abuse controls. blocked_hashes is the first scanner check (a nightly
-- mirror of a known-bad list can append to it; so can an admin).
-- notifications tell an org's members what the scanner or an admin did to
-- their file. reports come from anyone on the content host and are worked
-- from /admin, so they are a platform table with no RLS.

CREATE TABLE blocked_hashes (
	sha256 text PRIMARY KEY CHECK (sha256 ~ '^[0-9a-f]{64}$'),
	reason text NOT NULL DEFAULT '',
	added_by text,
	added_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE notifications (
	id text PRIMARY KEY,
	org_id text NOT NULL REFERENCES orgs (id) ON DELETE CASCADE,
	kind text NOT NULL,
	message text NOT NULL,
	file_id text,
	created_at timestamptz NOT NULL DEFAULT now(),
	read_at timestamptz
);

CREATE INDEX notifications_unread_idx ON notifications (org_id, created_at DESC)
	WHERE read_at IS NULL;

ALTER TABLE notifications ENABLE ROW LEVEL SECURITY;
ALTER TABLE notifications FORCE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON notifications USING (app_org_visible(org_id));

CREATE TABLE reports (
	id text PRIMARY KEY,
	org_id text NOT NULL,
	file_id text NOT NULL,
	version integer,
	reason text NOT NULL,
	reporter_ip_hash text NOT NULL,
	details text,
	created_at timestamptz NOT NULL DEFAULT now(),
	resolved_at timestamptz,
	resolution text
);

CREATE INDEX reports_open_idx ON reports (created_at DESC) WHERE resolved_at IS NULL;
CREATE INDEX reports_file_idx ON reports (file_id, created_at DESC);

-- migrate:down
DROP TABLE IF EXISTS reports;
DROP TABLE IF EXISTS notifications;
DROP TABLE IF EXISTS blocked_hashes;
