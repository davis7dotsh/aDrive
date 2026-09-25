import type { PgClient } from '@effect/sql-pg';
import { Effect } from 'effect';

export const fileIndexStatements = (db: D1Database, fileId: string) => [
	db.prepare('DELETE FROM files_fts WHERE file_id = ?').bind(fileId),
	db
		.prepare(
			`INSERT INTO files_fts (name, tags, body, file_id, chunk_no)
			SELECT
				f.display_name,
				COALESCE((
					SELECT group_concat(t.name, ' ')
					FROM file_tags ft
					JOIN tags t ON t.id = ft.tag_id
					WHERE ft.file_id = f.id
				), ''),
				substr(COALESCE(v.text_content, ''), 1, 65536),
				f.id,
				0
			FROM files f
			JOIN file_versions v
				ON v.file_id = f.id AND v.version = f.current_version
			WHERE f.id = ?`
		)
		.bind(fileId),
	db.prepare('DELETE FROM files_trgm WHERE file_id = ?').bind(fileId),
	db
		.prepare(
			`INSERT INTO files_trgm (name, file_id)
			SELECT display_name, id FROM files WHERE id = ?`
		)
		.bind(fileId)
];

export const refreshAllIndexedTagsStatement = (db: D1Database) =>
	db.prepare(
		`UPDATE files_fts
		SET tags = COALESCE((
			SELECT group_concat(t.name, ' ')
			FROM file_tags ft
			JOIN tags t ON t.id = ft.tag_id
			WHERE ft.file_id = files_fts.file_id
		), '')`
	);

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
