-- migrate:up
-- Slug changes. An owner may rename the org's content host once per 30
-- days (orgs.slug_changed_at); the previous slug is parked here so the
-- old host redirects to the new one for the same window. A parked slug
-- cannot be taken by another org while it still redirects.

ALTER TABLE orgs ADD COLUMN slug_changed_at timestamptz;

CREATE TABLE org_slug_history (
	slug text PRIMARY KEY,
	org_id text NOT NULL REFERENCES orgs (id) ON DELETE CASCADE,
	released_at timestamptz NOT NULL
);

CREATE INDEX org_slug_history_org_idx ON org_slug_history (org_id);

-- migrate:down
DROP TABLE IF EXISTS org_slug_history;
ALTER TABLE orgs DROP COLUMN IF EXISTS slug_changed_at;
