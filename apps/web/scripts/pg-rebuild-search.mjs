// Rebuilds search_documents (derived keyword-search state) from the
// canonical files, file_versions, tags, and file_tags tables. Mirrors
// refreshSearchDocument in src/lib/server/search-index.ts; keep the two
// SELECTs in sync.
//
//   bun scripts/pg-rebuild-search.mjs                  # DATABASE_URL or local default
//   bun scripts/pg-rebuild-search.mjs --url postgres://...
import Pg from 'pg';
import { LOCAL_DATABASE_URL } from './pg-migrate.mjs';

const urlFlag = process.argv.indexOf('--url');
const url =
	urlFlag >= 0
		? process.argv[urlFlag + 1]
		: (process.env.DATABASE_URL ?? LOCAL_DATABASE_URL);

const client = new Pg.Client({ connectionString: url });
await client.connect();
try {
	await client.query('BEGIN');
	await client.query('DELETE FROM search_documents');
	const inserted = await client.query(
		`INSERT INTO search_documents (file_id, chunk_no, name, tags, body)
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
			ON v.file_id = f.id AND v.version = f.current_version`
	);
	await client.query('COMMIT');
	console.log(`rebuilt ${inserted.rowCount ?? 0} search documents`);
} catch (cause) {
	await client.query('ROLLBACK');
	throw cause;
} finally {
	await client.end();
}
