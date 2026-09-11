-- migrate:up
-- Content scanning (services/scanner.ts). A publish by a verified org is
-- held (publish_pending) until the scanner clears it; a malicious verdict
-- on any org quarantines the file, which every content route then 404s.
-- One verdict row per (file, version, check).

ALTER TABLE files ADD COLUMN quarantined boolean NOT NULL DEFAULT false;
ALTER TABLE files ADD COLUMN publish_pending boolean NOT NULL DEFAULT false;

CREATE INDEX files_held_idx ON files (org_id, updated_at DESC)
	WHERE quarantined OR publish_pending;

CREATE TABLE scan_verdicts (
	file_id text NOT NULL REFERENCES files (id) ON DELETE CASCADE,
	org_id text NOT NULL REFERENCES orgs (id),
	version integer NOT NULL CHECK (version > 0),
	verdict text NOT NULL CHECK (verdict IN ('clean', 'suspicious', 'malicious')),
	source text NOT NULL,
	details jsonb NOT NULL DEFAULT '{}'::jsonb,
	created_at timestamptz NOT NULL DEFAULT now(),
	PRIMARY KEY (file_id, version, source)
);

CREATE INDEX scan_verdicts_review_idx ON scan_verdicts (verdict, created_at DESC)
	WHERE verdict <> 'clean';

ALTER TABLE scan_verdicts ENABLE ROW LEVEL SECURITY;
ALTER TABLE scan_verdicts FORCE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON scan_verdicts USING (app_org_visible(org_id));

-- migrate:down
DROP TABLE IF EXISTS scan_verdicts;
DROP INDEX IF EXISTS files_held_idx;
ALTER TABLE files DROP COLUMN IF EXISTS publish_pending;
ALTER TABLE files DROP COLUMN IF EXISTS quarantined;
