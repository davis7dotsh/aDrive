CREATE INDEX file_tags_tag_idx
	ON file_tags(tag_id, file_id);

CREATE VIRTUAL TABLE files_fts USING fts5(
	name,
	tags,
	body,
	file_id UNINDEXED,
	chunk_no UNINDEXED,
	tokenize = "unicode61 remove_diacritics 2"
);

CREATE VIRTUAL TABLE files_trgm USING fts5(
	name,
	file_id UNINDEXED,
	tokenize = "trigram"
);

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
