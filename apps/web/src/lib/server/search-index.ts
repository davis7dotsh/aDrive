import type { PgClient } from '@effect/sql-pg';
import { Effect } from 'effect';

// Postgres keyword index. One search_documents row per file today, so a
// refresh is delete then insert; chunk_no exists for splitting long bodies
// later. Runs inside whatever transaction the caller holds.
export const refreshSearchDocument = (sql: PgClient.PgClient, fileId: string) =>
	sql`DELETE FROM search_documents WHERE file_id = ${fileId}`.pipe(
		Effect.andThen(
			sql`INSERT INTO search_documents (file_id, chunk_no, name, tags, body)
				SELECT
					f.id,
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
				WHERE f.id = ${fileId}`
		),
		Effect.asVoid
	);

export const refreshAllIndexedTags = (sql: PgClient.PgClient) =>
	sql`UPDATE search_documents d
		SET tags = COALESCE((
			SELECT string_agg(t.name, ' ' ORDER BY t.normalized_name)
			FROM file_tags ft
			JOIN tags t ON t.id = ft.tag_id
			WHERE ft.file_id = d.file_id
		), '')`.pipe(Effect.asVoid);
