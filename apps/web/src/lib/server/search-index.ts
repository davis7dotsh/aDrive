import type { PgClient } from '@effect/sql-pg';
import { Effect } from 'effect';

// Every keyword writer within an org shares this transaction lock. Acquire
// it separately so reads after waiting use a fresh database snapshot.
// A nested helper retains the lock until its caller's transaction commits.
// Stable advisory namespace: ASCII "adri", followed by the org hash.
const keywordWriteLock = (sql: PgClient.PgClient, orgId: string) =>
	sql`SELECT pg_advisory_xact_lock(1633972841, hashtext(${orgId}))`;

// Postgres keyword index. One search_documents row per file today, so a
// refresh is delete then insert; chunk_no exists for splitting long bodies
// later. Tag renames and document replacements must serialize together.
export const refreshSearchDocument = (
	sql: PgClient.PgClient,
	fileId: string,
	orgId: string
) =>
	sql.withTransaction(
		Effect.gen(function* () {
			yield* keywordWriteLock(sql, orgId);
			yield* sql`DELETE FROM search_documents
				WHERE file_id = ${fileId} AND org_id = ${orgId}`;
			yield* sql`INSERT INTO search_documents (file_id, org_id, chunk_no, name, tags, body)
				SELECT
					f.id,
					f.org_id,
					0,
					f.display_name,
					COALESCE((
						SELECT string_agg(t.name, ' ' ORDER BY t.normalized_name)
						FROM file_tags ft
						JOIN tags t ON t.id = ft.tag_id
						WHERE ft.file_id = f.id AND t.org_id = ${orgId}
					), ''),
					left(COALESCE(v.text_content, ''), 65536)
				FROM files f
				JOIN file_versions v
					ON v.file_id = f.id AND v.org_id = ${orgId}
						AND v.version = f.current_version
				WHERE f.id = ${fileId} AND f.org_id = ${orgId}`;
		})
	);

export const refreshAllIndexedTags = (sql: PgClient.PgClient, orgId: string) =>
	sql.withTransaction(
		Effect.gen(function* () {
			yield* keywordWriteLock(sql, orgId);
			yield* sql`UPDATE search_documents d
				SET tags = COALESCE((
					SELECT string_agg(t.name, ' ' ORDER BY t.normalized_name)
					FROM file_tags ft
					JOIN tags t ON t.id = ft.tag_id
					WHERE ft.file_id = d.file_id AND t.org_id = ${orgId}
				), '')
				WHERE d.org_id = ${orgId}`;
		})
	);
