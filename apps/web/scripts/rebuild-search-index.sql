-- files_fts and files_trgm are derived state. This script deliberately reads
-- only canonical tables and never invokes FTS maintenance commands.
DELETE FROM files_fts;
DELETE FROM files_trgm;

INSERT INTO files_fts (name, tags, body, file_id, chunk_no)
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
	ON v.file_id = f.id AND v.version = f.current_version;

INSERT INTO files_trgm (name, file_id)
SELECT display_name, id
FROM files;
