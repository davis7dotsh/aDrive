-- migrate:up
-- Billing counters beside the storage meter. ai_ops_month is this
-- UTC calendar month's embedded chunk count for the billing page; it
-- resets on the next increment after ai_ops_month_reset_at. Sync sends
-- the absolute current total, so a failed acknowledgement is safe to retry.
ALTER TABLE org_usage
	ADD COLUMN ai_ops_month integer NOT NULL DEFAULT 0
		CHECK (ai_ops_month >= 0);
ALTER TABLE org_usage ADD COLUMN ai_ops_month_reset_at timestamptz;

-- migrate:down
ALTER TABLE org_usage DROP COLUMN ai_ops_month_reset_at;
ALTER TABLE org_usage DROP COLUMN ai_ops_month;
