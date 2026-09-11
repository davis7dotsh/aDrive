import { Effect } from 'effect';
import { describe, expect, it } from 'vitest';
import { PgSql } from './pg';
import { completePurge } from './purge-sql';
import { testPgLayer } from './test/pg';

const run = <A, E>(effect: Effect.Effect<A, E, PgSql>) =>
	Effect.runPromise(effect.pipe(Effect.provide(testPgLayer())));

const seedPurgingFile = (fileId: string, kind: 'file' | 'site') =>
	Effect.gen(function* () {
		const sql = yield* PgSql;
		const now = '2026-07-27T00:00:00.000Z';
		const isSite = kind === 'site';
		yield* sql`
			INSERT INTO files (
				id, display_name, content_type, kind, current_version, size_bytes,
				public, is_site, created_at, updated_at, deleted_at, purge_at, purge_state
			) VALUES (
				${fileId}, ${`${kind}-name`}, ${isSite ? 'text/html' : 'text/plain'},
				${kind}, 1, 42, true, ${isSite}, ${now}, ${now}, ${now}, ${now}, 'pending'
			)`;
		yield* sql`
			INSERT INTO file_versions (
				file_id, version, r2_key, size_bytes, content_type, created_at, text_content
			) VALUES (
				${fileId}, 1, ${isSite ? `site-version/${fileId}/1` : `v/${fileId}/1`},
				42, ${isSite ? 'text/html' : 'text/plain'}, ${now}, 'purge body'
			)`;
		yield* sql`
			INSERT INTO tags (id, name, normalized_name, created_at)
			VALUES (${`tag-${fileId}`}, 'purge-tag', ${`purge-tag-${fileId}`}, ${now})`;
		yield* sql`INSERT INTO file_tags (file_id, tag_id) VALUES (${fileId}, ${`tag-${fileId}`})`;
		yield* sql`
			INSERT INTO search_documents (file_id, chunk_no, name, tags, body)
			VALUES (${fileId}, 0, ${`${kind}-name`}, 'purge-tag', 'purge body')`;
		yield* sql`
			INSERT INTO file_chunks (file_id, version, ordinal, char_start, char_end)
			VALUES (${fileId}, 1, 0, 0, 10), (${fileId}, 1, 1, 8, 18)`;
		if (isSite) {
			yield* sql`
				INSERT INTO site_assets (file_id, version, path, r2_key, content_type, size_bytes)
				VALUES (${fileId}, 1, 'index.html', ${`s/${fileId}/1/index`}, 'text/html', 42)`;
		}
	});

const counts = (fileId: string) =>
	Effect.gen(function* () {
		const sql = yield* PgSql;
		const rows = yield* sql<{
			files: number;
			versions: number;
			file_tags: number;
			site_assets: number;
			documents: number;
			chunks: number;
		}>`
			SELECT
				(SELECT count(*) FROM files WHERE id = ${fileId}) AS files,
				(SELECT count(*) FROM file_versions WHERE file_id = ${fileId}) AS versions,
				(SELECT count(*) FROM file_tags WHERE file_id = ${fileId}) AS file_tags,
				(SELECT count(*) FROM site_assets WHERE file_id = ${fileId}) AS site_assets,
				(SELECT count(*) FROM search_documents WHERE file_id = ${fileId}) AS documents,
				(SELECT count(*) FROM file_chunks WHERE file_id = ${fileId}) AS chunks`;
		return rows[0];
	});

describe('purge completion on postgres', () => {
	it.each(['file', 'site'] as const)(
		'removes the %s row and everything that hangs off it',
		async (kind) => {
			const fileId = `purge-${kind}-${crypto.randomUUID()}`;
			const result = await run(
				Effect.gen(function* () {
					const sql = yield* PgSql;
					yield* seedPurgingFile(fileId, kind);
					const before = yield* counts(fileId);
					yield* completePurge(sql, fileId);
					const after = yield* counts(fileId);
					return { before, after };
				})
			);
			expect(result.before).toEqual({
				files: 1,
				versions: 1,
				file_tags: 1,
				site_assets: kind === 'site' ? 1 : 0,
				documents: 1,
				chunks: 2
			});
			expect(result.after).toEqual({
				files: 0,
				versions: 0,
				file_tags: 0,
				site_assets: 0,
				documents: 0,
				chunks: 0
			});
		}
	);

	it('fails and keeps every row when purge ownership is no longer pending', async () => {
		const fileId = `purge-stale-${crypto.randomUUID()}`;
		const result = await run(
			Effect.gen(function* () {
				const sql = yield* PgSql;
				yield* seedPurgingFile(fileId, 'file');
				yield* sql`UPDATE files SET purge_state = 'failed' WHERE id = ${fileId}`;
				const outcome = yield* completePurge(sql, fileId).pipe(
					Effect.as('completed'),
					Effect.catchTag('StorageError', (failure) =>
						Effect.succeed(failure.operation)
					)
				);
				return { outcome, after: yield* counts(fileId) };
			})
		);
		expect(result.outcome).toBe('finish file purge');
		expect(result.after).toEqual({
			files: 1,
			versions: 1,
			file_tags: 1,
			site_assets: 0,
			documents: 1,
			chunks: 2
		});
	});
});
