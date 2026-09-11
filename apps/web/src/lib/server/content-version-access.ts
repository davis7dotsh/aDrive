import type { PgClient } from '@effect/sql-pg';

// Used by both file and thumbnail lookups, before consulting any cache.
// Public status belongs to the current file, but it does not clear older
// bytes that may never have been scanned. Owner grants can still reach
// those versions; a malicious verdict excludes a version even with a grant.
export const contentVersionAccess = (sql: PgClient.PgClient) => ({
	review: sql`
		LEFT JOIN LATERAL (
			SELECT
				max(verdict) FILTER (WHERE source = 'admin') AS admin_verdict,
				count(*) FILTER (
					WHERE source IN ('hash', 'sniff', 'urlscan') AND verdict = 'clean'
				) = 3 AND NOT COALESCE(bool_or(verdict <> 'clean')
					FILTER (WHERE source <> 'admin'), false) AS scanned_clean,
				COALESCE(bool_or(verdict = 'malicious')
					FILTER (WHERE source <> 'admin'), false) AS malicious
			FROM scan_verdicts
			WHERE file_id = f.id AND org_id = f.org_id AND version = v.version
		) scan_access ON true
	`,
	allowed: sql`COALESCE(scan_access.admin_verdict <> 'malicious', NOT scan_access.malicious)`,
	isPublic: sql`f.public AND (
		v.version = f.current_version
		OR COALESCE(scan_access.admin_verdict = 'clean', false)
		OR (
			scan_access.admin_verdict IS NULL AND scan_access.scanned_clean
			AND v.scan_next_run_at IS NULL
		)
	)`
});
