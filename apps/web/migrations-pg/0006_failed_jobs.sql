-- migrate:up
-- Jobs the queue gave up on. The Worker consumes the dead-letter queue
-- into this table so an operator (and the admin UI) can see what failed
-- and why, then re-send once the cause is fixed. Platform table: rows
-- are looked up by org, never joined into tenant queries, so no RLS.
CREATE TABLE failed_jobs (
	id text PRIMARY KEY,
	org_id text,
	kind text NOT NULL,
	payload jsonb NOT NULL,
	error text NOT NULL,
	attempts integer NOT NULL,
	failed_at timestamptz NOT NULL DEFAULT now(),
	resolved_at timestamptz
);

CREATE INDEX failed_jobs_org_idx ON failed_jobs (org_id, failed_at DESC);

-- migrate:down
DROP TABLE IF EXISTS failed_jobs;
