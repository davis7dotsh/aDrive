-- migrate:up
-- A periodic absolute snapshot repairs lost enqueues and acknowledgements.
ALTER TABLE org_usage
	ADD COLUMN usage_sync_next_run_at timestamptz NOT NULL DEFAULT now();

-- Reserve quota before calling the embedder. Only a successful semantic
-- commit consumes the reservation and records billable usage. Abandoned
-- reservations expire with the indexing lease.
CREATE TABLE ai_usage_reservations (
	token text PRIMARY KEY,
	org_id text NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
	value integer NOT NULL CHECK (value > 0),
	expires_at timestamptz NOT NULL
);
CREATE INDEX ai_usage_reservations_org ON ai_usage_reservations (org_id, expires_at);
ALTER TABLE ai_usage_reservations ENABLE ROW LEVEL SECURITY;
ALTER TABLE ai_usage_reservations FORCE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON ai_usage_reservations USING (app_org_visible(org_id));

-- migrate:down
DROP TABLE ai_usage_reservations;
ALTER TABLE org_usage
	DROP COLUMN usage_sync_next_run_at;
