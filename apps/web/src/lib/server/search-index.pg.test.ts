import { Effect } from 'effect';
import { describe, expect, it } from 'vitest';
import { PgSql } from './pg';
import { refreshAllIndexedTags, refreshSearchDocument } from './search-index';
import { ensureStoredBytesWithin } from './storage-quota';
import { testPgLayer } from './test/pg';

const run = <A, E>(effect: Effect.Effect<A, E, PgSql>) =>
	Effect.runPromise(effect.pipe(Effect.provide(testPgLayer())));

describe('postgres search index helpers', () => {
	it('builds and refreshes a search document with tags and body', async () => {
		const id = `si-${crypto.randomUUID()}`;
		const tagId = `tag-${crypto.randomUUID()}`;
		const result = await run(
			Effect.gen(function* () {
				const sql = yield* PgSql;
				const now = new Date().toISOString();
				yield* sql`INSERT INTO files (id, display_name, content_type, size_bytes, created_at, updated_at)
					VALUES (${id}, ${'Quarterly report.pdf'}, ${'application/pdf'}, ${10}, ${now}, ${now})`;
				yield* sql`INSERT INTO file_versions (file_id, version, r2_key, size_bytes, content_type, created_at, text_content)
					VALUES (${id}, ${1}, ${`v/${id}/1`}, ${10}, ${'application/pdf'}, ${now}, ${'revenue grew in the third quarter'})`;
				yield* sql`INSERT INTO tags (id, name, normalized_name, created_at)
					VALUES (${tagId}, ${'Finance'}, ${`finance-${tagId}`}, ${now})`;
				yield* sql`INSERT INTO file_tags (file_id, tag_id) VALUES (${id}, ${tagId})`;
				yield* refreshSearchDocument(sql, id);
				const before = yield* sql<{ name: string; tags: string; hit: boolean }>`
					SELECT name, tags, tsv @@ websearch_to_tsquery('english', 'revenue quarter') AS hit
					FROM search_documents WHERE file_id = ${id}`;
				yield* sql`UPDATE tags SET name = ${'Money'} WHERE id = ${tagId}`;
				yield* refreshAllIndexedTags(sql);
				const after = yield* sql<{ tags: string }>`
					SELECT tags FROM search_documents WHERE file_id = ${id}`;
				const quota = yield* ensureStoredBytesWithin(sql, 1_000_000, 5).pipe(
					Effect.as('ok'),
					Effect.catch(() => Effect.succeed('blocked'))
				);
				const blocked = yield* ensureStoredBytesWithin(sql, 1, 5).pipe(
					Effect.as('ok'),
					Effect.catchTag('InvalidRequest', (failure) =>
						Effect.succeed(String(failure.status))
					)
				);
				return { before: before[0], after: after[0], quota, blocked };
			})
		);
		expect(result.before).toEqual({
			name: 'Quarterly report.pdf',
			tags: 'Finance',
			hit: true
		});
		expect(result.after?.tags).toBe('Money');
		expect(result.quota).toBe('ok');
		expect(result.blocked).toBe('413');
	});
});
