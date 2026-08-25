-- The reserved multipart tables (upload_sessions / upload_parts from 0001)
-- carry the file identity and R2 multipart handle. Staged/resumable uploads
-- also need to remember the destination file's tags and expiry so finalize can
-- produce a normal file row identical to a one-shot PUT. tags holds a JSON
-- array of tag names (resolved at finalize); file_expires_at is the optional
-- ISO expiry for the finished file.
ALTER TABLE upload_sessions ADD COLUMN tags TEXT NOT NULL DEFAULT '[]';
ALTER TABLE upload_sessions ADD COLUMN file_expires_at TEXT;
