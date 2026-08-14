ALTER TABLE file_versions
	ADD COLUMN thumbnail_r2_key TEXT;

ALTER TABLE file_versions
	ADD COLUMN thumbnail_size_bytes INTEGER NOT NULL DEFAULT 0
	CHECK (thumbnail_size_bytes >= 0);
