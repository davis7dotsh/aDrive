-- Tracks the hash of the active passcode so a rotation (a new PASSCODE
-- secret on the Worker) can be detected and revoke sessions/device codes.
CREATE TABLE credential_state (
	id INTEGER PRIMARY KEY CHECK (id = 1),
	passcode_hash TEXT NOT NULL CHECK (length(passcode_hash) = 64),
	rotated_at TEXT NOT NULL
);
