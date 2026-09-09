import { Effect } from 'effect';
import { describe, expect, it } from 'vitest';
import {
	dashboardFileColumns,
	decodeDashboardRows,
	toDashboardFile
} from './file-rows';
import { PgSql } from './pg';
import { testPgLayer } from './test/pg';

describe('dashboard file rows on postgres', () => {
	it('decodes booleans, timestamps, and aggregated tags', async () => {
		const id = `fr-${crypto.randomUUID()}`;
		const tagId = `tag-${crypto.randomUUID()}`;
		const file = await Effect.runPromise(
			Effect.gen(function* () {
				const sql = yield* PgSql;
				const now = '2026-09-09T00:00:00.000Z';
				yield* sql`INSERT INTO files (id, display_name, content_type, size_bytes, public, created_at, updated_at)
					VALUES (${id}, ${'page.html'}, ${'text/html'}, ${10}, ${false}, ${now}, ${now})`;
				yield* sql`INSERT INTO file_versions (file_id, version, r2_key, size_bytes, content_type, created_at)
					VALUES (${id}, ${1}, ${`v/${id}/1`}, ${10}, ${'text/html'}, ${now})`;
				yield* sql`INSERT INTO tags (id, name, normalized_name, created_at)
					VALUES (${tagId}, ${'Web'}, ${`web-${tagId}`}, ${now})`;
				yield* sql`INSERT INTO file_tags (file_id, tag_id) VALUES (${id}, ${tagId})`;
				const rows = yield* sql.unsafe(
					`SELECT ${dashboardFileColumns} FROM files f WHERE f.id = $1`,
					[id]
				);
				return decodeDashboardRows(rows).map(toDashboardFile)[0];
			}).pipe(Effect.provide(testPgLayer()))
		);
		expect(file).toMatchObject({
			id,
			public: false,
			htmlForcedPublic: true,
			createdAt: '2026-09-09T00:00:00.000Z',
			tags: [{ id: tagId, name: 'Web', fileCount: 0 }]
		});
	});
});
