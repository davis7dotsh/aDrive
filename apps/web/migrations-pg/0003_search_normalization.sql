-- migrate:up
-- Keep literal metadata lexemes, and give every field the same English
-- normalization so one query can match terms spanning metadata and body.
-- Merge each field's canonical vector text to retain original positions:
-- tsvector concatenation would shift aliases and create synthetic phrases.
-- PostgreSQL rewrites existing generated values and maintains the GIN index.
ALTER TABLE search_documents ALTER COLUMN tsv SET EXPRESSION AS (
	(setweight(to_tsvector('simple', name), 'A')::text
		|| ' ' || setweight(to_tsvector('english', name), 'A')::text)::tsvector
	|| (setweight(to_tsvector('simple', tags), 'B')::text
		|| ' ' || setweight(to_tsvector('english', tags), 'B')::text)::tsvector
	|| setweight(to_tsvector('english', body), 'C')
);

-- migrate:down
ALTER TABLE search_documents ALTER COLUMN tsv SET EXPRESSION AS (
	setweight(to_tsvector('simple', name), 'A')
	|| setweight(to_tsvector('simple', tags), 'B')
	|| setweight(to_tsvector('english', body), 'C')
);
