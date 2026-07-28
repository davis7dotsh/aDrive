CREATE TABLE instance_secrets (
	id INTEGER PRIMARY KEY CHECK (id = 1),
	content_grant_signing_key TEXT NOT NULL CHECK (
		length(content_grant_signing_key) = 43
		AND content_grant_signing_key NOT GLOB '*[^A-Za-z0-9_-]*'
	),
	created_at TEXT NOT NULL
);
