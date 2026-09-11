import { Cause, Effect, Exit } from 'effect';
import Pg from 'pg';
import { describe, expect, it } from 'vitest';
import { PgSql, pgLayer } from './pg';
import { refreshAllIndexedTags, refreshSearchDocument } from './search-index';
import { ensureStoredBytesWithin } from './storage-quota';
import { TEST_DATABASE_URL } from './test/database';
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

	it.each([
		{ first: 'refresh', existingDocument: true },
		{ first: 'rename', existingDocument: true },
		{ first: 'refresh', existingDocument: false },
		{ first: 'rename', existingDocument: false }
	] as const)(
		'keeps renamed tags when $first starts first (existing document: $existingDocument)',
		async ({ first, existingDocument }) => {
			const id = `index-race-${crypto.randomUUID()}`;
			const tagId = `tag-${crypto.randomUUID()}`;
			const oldName = 'Before rename';
			const newName = 'After rename';
			const second = first === 'refresh' ? 'rename' : 'refresh';
			const secondApplication = `${id}-second`;
			const release = Promise.withResolvers<void>();
			let firstPaused = false;
			const mutate = (kind: typeof first, pause: boolean) => {
				const url = new URL(TEST_DATABASE_URL);
				url.searchParams.set(
					'application_name',
					pause ? `${id}-first` : secondApplication
				);
				return Effect.runPromiseExit(
					Effect.gen(function* () {
						const sql = yield* PgSql;
						yield* sql.withTransaction(
							Effect.gen(function* () {
								if (kind === 'rename') {
									yield* sql`UPDATE tags SET name = ${newName} WHERE id = ${tagId}`;
									yield* refreshAllIndexedTags(sql);
								} else {
									yield* refreshSearchDocument(sql, id);
								}
								if (pause) {
									firstPaused = true;
									yield* Effect.promise(() => release.promise);
								}
							})
						);
					}).pipe(Effect.provide(pgLayer({ connectionString: url.href })))
				);
			};
			const writes: ReturnType<typeof mutate>[] = [];
			const control = new Pg.Client({ connectionString: TEST_DATABASE_URL });
			await control.connect();
			try {
				await control.query(
					`INSERT INTO files (id, display_name, content_type, size_bytes, created_at, updated_at)
					VALUES ($1, 'Search refresh fixture', 'text/plain', 0, now(), now())`,
					[id]
				);
				await control.query(
					`INSERT INTO file_versions (file_id, version, r2_key, size_bytes, content_type, created_at)
					VALUES ($1, 1, $1, 0, 'text/plain', now())`,
					[id]
				);
				await control.query(
					`INSERT INTO tags (id, name, normalized_name, created_at)
					VALUES ($1, $2, $1, now())`,
					[tagId, oldName]
				);
				await control.query(
					'INSERT INTO file_tags (file_id, tag_id) VALUES ($1, $2)',
					[id, tagId]
				);
				if (existingDocument) {
					await run(
						Effect.flatMap(PgSql, (sql) => refreshSearchDocument(sql, id))
					);
				}

				// Hold the first caller's outer transaction open after its helper
				// finishes. The second helper must wait before reading tags or
				// documents, including when there is no existing document to lock.
				writes.push(mutate(first, true));
				await expect
					.poll(() => firstPaused, { timeout: 5_000, interval: 10 })
					.toBe(true);
				writes.push(mutate(second, false));
				await expect
					.poll(
						async () =>
							(
								await control.query(
									`SELECT pid FROM pg_stat_activity
									WHERE datname = current_database() AND application_name = $1
									AND wait_event_type = 'Lock'`,
									[secondApplication]
								)
							).rowCount,
						{ timeout: 5_000, interval: 10 }
					)
					.toBe(1);
				release.resolve();
				for (const outcome of await Promise.all(writes)) {
					expect(
						Exit.isSuccess(outcome),
						Exit.isFailure(outcome) ? Cause.pretty(outcome.cause) : undefined
					).toBe(true);
				}
				expect(
					(
						await control.query(
							'SELECT tags FROM search_documents WHERE file_id = $1',
							[id]
						)
					).rows
				).toEqual([{ tags: newName }]);
			} finally {
				release.resolve();
				await Promise.all(writes);
				try {
					await control.query('DELETE FROM files WHERE id = $1', [id]);
					await control.query('DELETE FROM tags WHERE id = $1', [tagId]);
				} finally {
					await control.end();
				}
			}
		}
	);
});
