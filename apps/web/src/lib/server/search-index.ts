import type { PgClient } from '@effect/sql-pg';
import { Effect } from 'effect';

// Every keyword writer shares this transaction lock. Acquire it in a
// separate statement so reads after waiting use a fresh database snapshot.
// A nested helper retains the lock until its caller's transaction commits.
// Stable advisory namespace: ASCII "adri" / "sear" for aDrive search.
const keywordWriteLock = (sql: PgClient.PgClient) =>
	sql`SELECT pg_advisory_xact_lock(1633972841, 1936023922)`;

// Postgres keyword index. One search_documents row per file today, so a
// refresh is delete then insert; chunk_no exists for splitting long bodies
// later. Tag renames and document replacements must serialize together.
export const refreshSearchDocument = (sql: PgClient.PgClient, fileId: string) =>
	sql.withTransaction(
		Effect.gen(function* () {
			yield* keywordWriteLock(sql);
			yield* sql`DELETE FROM search_documents WHERE file_id = ${fileId}`;
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
						WHERE ft.file_id = f.id
					), ''),
					left(COALESCE(v.text_content, ''), 65536)
				FROM files f
				JOIN file_versions v
					ON v.file_id = f.id AND v.version = f.current_version
				WHERE f.id = ${fileId}`;
		})
	);

export const refreshAllIndexedTags = (sql: PgClient.PgClient) =>
	sql.withTransaction(
		Effect.gen(function* () {
			yield* keywordWriteLock(sql);
			yield* sql`UPDATE search_documents d
				SET tags = COALESCE((
					SELECT string_agg(t.name, ' ' ORDER BY t.normalized_name)
					FROM file_tags ft
					JOIN tags t ON t.id = ft.tag_id
					WHERE ft.file_id = d.file_id
				), '')`;
		})
	);
