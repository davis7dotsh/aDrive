-- Scoped tokens narrow a full-drive adr_ key to a set of tags and/or explicit
-- file IDs. Both columns hold a JSON array of ids; NULL means "no restriction"
-- on that axis. A key is unrestricted (full drive) only when both are NULL.
-- Existing keys keep NULL for both and stay full-drive.
ALTER TABLE api_keys ADD COLUMN allowed_tag_ids TEXT;
ALTER TABLE api_keys ADD COLUMN allowed_file_ids TEXT;
