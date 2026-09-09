-- migrate:up
-- Billing counters beside the storage meter. ai_ops_month is this
-- calendar month's embedded chunk count for the billing page; it is
-- reset by the next increment after ai_ops_month_reset_at. ai_ops_pending
-- is what the usage-sync job has not yet tracked into Autumn; the job
-- subtracts what it sent, so a failed send is retried, never lost.
ALTER TABLE org_usage
	ADD COLUMN ai_ops_month integer NOT NULL DEFAULT 0
		CHECK (ai_ops_month >= 0);
ALTER TABLE org_usage ADD COLUMN ai_ops_month_reset_at timestamptz;
ALTER TABLE org_usage
	ADD COLUMN ai_ops_pending integer NOT NULL DEFAULT 0
		CHECK (ai_ops_pending >= 0);

-- migrate:down
ALTER TABLE org_usage DROP COLUMN ai_ops_pending;
ALTER TABLE org_usage DROP COLUMN ai_ops_month_reset_at;
ALTER TABLE org_usage DROP COLUMN ai_ops_month;
