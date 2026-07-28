ALTER TABLE files ADD COLUMN purge_attempts INTEGER NOT NULL DEFAULT 0
	CHECK (purge_attempts >= 0);
ALTER TABLE files ADD COLUMN purge_error TEXT;
ALTER TABLE files ADD COLUMN purge_next_run_at TEXT;

ALTER TABLE pending_vector_deletes ADD COLUMN attempts INTEGER NOT NULL DEFAULT 0
	CHECK (attempts >= 0);
ALTER TABLE pending_vector_deletes ADD COLUMN last_error TEXT;
ALTER TABLE pending_vector_deletes ADD COLUMN next_run_at TEXT;

CREATE INDEX files_index_jobs_idx
	ON files(index_state, index_next_run_at, updated_at);

CREATE INDEX files_purge_jobs_idx
	ON files(purge_state, purge_next_run_at, purge_at, expires_at);

CREATE INDEX pending_vector_deletes_retry_idx
	ON pending_vector_deletes(next_run_at, queued_at);
