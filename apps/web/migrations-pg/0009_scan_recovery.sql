-- migrate:up
-- Persist scan work with the version write so a lost post-commit queue
-- send can be recovered. The timestamp also fences a completed scan
-- from clearing a newer request for the same immutable version.
ALTER TABLE file_versions ADD COLUMN scan_next_run_at timestamptz;

CREATE INDEX file_versions_scan_due_idx
	ON file_versions (org_id, scan_next_run_at, file_id, version)
	WHERE scan_next_run_at IS NOT NULL;

-- migrate:down
DROP INDEX IF EXISTS file_versions_scan_due_idx;
ALTER TABLE file_versions DROP COLUMN IF EXISTS scan_next_run_at;
