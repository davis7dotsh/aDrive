import { Effect } from 'effect';
import {
	CurrentTransformer,
	type Statement
} from 'effect/unstable/sql/Statement';
import { describe, expect, it } from 'vitest';
import { PgSql } from '../pg';
import { ensureTestOrg, TEST_ORG_ID } from '../test/org';
import { testPgLayer } from '../test/pg';
import { chunkSearchText } from '../semantic-policy';
import { searchTextLimit } from '../search-text';
import { makeVectorIndex } from './semantic';

const NOW = '2026-07-27T00:00:00.000Z';

const run = <A, E>(effect: Effect.Effect<A, E, PgSql>) =>
	Effect.runPromise(effect.pipe(Effect.provide(testPgLayer())));

const unitVector = (axis: number) =>
	Array.from({ length: 384 }, (_, index) => (index === axis ? 1 : 0));

// Points between two axes so the nearest file is unambiguous.
const between = (primary: number, secondary: number) =>
	Array.from({ length: 384 }, (_, index) =>
		index === primary ? 0.9 : index === secondary ? 0.1 : 0
	);

const seedFile = (
	id: string,
	options: {
		readonly tagId?: string;
		readonly deletedAt?: string;
		readonly expiresAt?: string;
	} = {}
) =>
	Effect.gen(function* () {
		const sql = yield* PgSql;
		yield* ensureTestOrg(sql);
		yield* sql`INSERT INTO files (
				id, org_id, display_name, content_type, current_version, size_bytes,
				created_at, updated_at, deleted_at, expires_at
			) VALUES (${id}, ${TEST_ORG_ID}, ${`${id}.txt`}, 'text/plain', 2, 1, ${NOW}, ${NOW}, ${options.deletedAt ?? null}, ${options.expiresAt ?? null})`;
		if (options.tagId) {
			yield* sql`INSERT INTO file_tags (file_id, tag_id) VALUES (${id}, ${options.tagId})`;
		}
	});

describe('pgvector index', () => {
	it('returns the nearest visible files once per file, honouring tags', async () => {
		const prefix = `vec-${crypto.randomUUID()}`;
		const [near, far, deleted, expired, staleVersion] = [
			`${prefix}-near`,
			`${prefix}-far`,
			`${prefix}-deleted`,
			`${prefix}-expired`,
			`${prefix}-stale`
		];
		const tagId = `${prefix}-tag`;
		const result = await run(
			Effect.gen(function* () {
				const sql = yield* PgSql;
				const index = makeVectorIndex(sql, true);
				yield* ensureTestOrg(sql);
				yield* sql`INSERT INTO tags (id, org_id, name, normalized_name, created_at)
					VALUES (${tagId}, ${TEST_ORG_ID}, ${tagId}, ${tagId}, ${NOW})`;
				yield* seedFile(near, { tagId });
				yield* seedFile(far);
				yield* seedFile(deleted, { deletedAt: NOW });
				yield* seedFile(expired, { expiresAt: NOW });
				yield* seedFile(staleVersion);
				const chunk = (
					fileId: string,
					version: number,
					ordinal: number,
					axis: number
				) => ({
					fileId,
					version,
					ordinal,
					charStart: 0,
					charEnd: 1,
					values: unitVector(axis)
				});
				yield* index.upsert([
					// Two chunks for one file: the second is the nearest overall.
					chunk(near, 2, 0, 5),
					chunk(near, 2, 1, 0),
					chunk(far, 2, 0, 1),
					chunk(deleted, 2, 0, 0),
					chunk(expired, 2, 0, 0),
					// Rows for a superseded version never match.
					chunk(staleVersion, 1, 0, 0)
				]);
				// Re-upserting the same key replaces the embedding in place.
				yield* index.upsert([chunk(far, 2, 0, 2)]);
				const query = between(0, 1);
				const filter = { orgId: TEST_ORG_ID, now: NOW, tagIds: [] };
				const all = yield* index.search(query, filter);
				const tagged = yield* index.search(query, {
					...filter,
					tagIds: [tagId]
				});
				const none = yield* index.search(null, filter);
				const count = yield* index.count(TEST_ORG_ID);
				const mine = (rows: ReadonlyArray<{ fileId: string }>) =>
					rows.map((row) => row.fileId).filter((id) => id.startsWith(prefix));
				return { all: mine(all), tagged: mine(tagged), none, count };
			})
		);
		expect(result.all).toEqual([near, far]);
		expect(result.tagged).toEqual([near]);
		expect(result.none).toEqual([]);
		expect(result.count).toBeGreaterThanOrEqual(5);
	});

	it('uses HNSW and fills the file pool despite duplicate and filtered chunks', async () => {
		const prefix = `vec-pool-${crypto.randomUUID()}`;
		const tagId = `${prefix}-tag`;
		const ids = Array.from({ length: 110 }, (_, index) => `${prefix}-${index}`);
		const excluded = Array.from(
			{ length: 80 },
			(_, index) => `${prefix}-excluded-${index}`
		);
		const chunks = chunkSearchText('large.txt', 'x'.repeat(searchTextLimit));
		const result = await run(
			Effect.gen(function* () {
				const sql = yield* PgSql;
				const index = makeVectorIndex(sql, true);
				yield* ensureTestOrg(sql);
				yield* sql`INSERT INTO tags (id, org_id, name, normalized_name, created_at)
					VALUES (${tagId}, ${TEST_ORG_ID}, ${tagId}, ${tagId}, ${NOW})`;
				yield* sql`INSERT INTO files ${sql.insert(
					[...ids, ...excluded].map((id) => ({
						id,
						org_id: TEST_ORG_ID,
						display_name: id,
						content_type: 'text/plain',
						current_version: 2,
						size_bytes: 1,
						created_at: NOW,
						updated_at: NOW
					}))
				)}`;
				yield* sql`INSERT INTO file_tags ${sql.insert(
					ids.map((id) => ({ file_id: id, tag_id: tagId }))
				)}`;
				yield* index.upsert(
					ids.flatMap((fileId, fileIndex) =>
						chunks.map((chunk) => ({
							fileId,
							version: 2,
							ordinal: chunk.ordinal,
							charStart: chunk.charStart,
							charEnd: chunk.charEnd,
							values: Array.from({ length: 384 }, (_, axis) =>
								axis === 0 ? 1 : axis === 1 ? (fileIndex + 1) / 100 : 0
							)
						}))
					)
				);
				yield* index.upsert(
					excluded.map((fileId) => ({
						fileId,
						version: 2,
						ordinal: 0,
						charStart: 0,
						charEnd: 1,
						values: unitVector(0)
					}))
				);
				return yield* sql.withTransaction(
					Effect.gen(function* () {
						yield* sql`SET LOCAL enable_seqscan = off`;
						yield* sql`SET LOCAL enable_sort = off`;
						let compiled: ReturnType<Statement<unknown>['compile']> | undefined;
						const rows = yield* index
							.search(unitVector(0), {
								orgId: TEST_ORG_ID,
								now: NOW,
								tagIds: [tagId]
							})
							.pipe(
								Effect.provideService(CurrentTransformer, (statement) => {
									const query = statement.compile();
									if (query[0].includes('FROM file_chunks')) compiled = query;
									return Effect.succeed(statement);
								})
							);
						if (!compiled)
							throw new Error('The candidate query was not captured');
						const plan = yield* sql.unsafe(
							`EXPLAIN (FORMAT JSON) ${compiled[0]}`,
							compiled[1]
						);
						return { rows, plan: JSON.stringify(plan) };
					})
				);
			})
		);
		expect(result.rows.map((row) => row.fileId)).toEqual(ids.slice(0, 100));
		expect(result.plan).toContain('file_chunks_embedding_idx');
	});
});
