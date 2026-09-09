import { Effect } from 'effect';
import { describe, expect, it } from 'vitest';
import { PgSql } from '../pg';
import { testPgLayer } from '../test/pg';
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
	options: { readonly tagId?: string; readonly deletedAt?: string } = {}
) =>
	Effect.gen(function* () {
		const sql = yield* PgSql;
		yield* sql`INSERT INTO files (
				id, display_name, content_type, current_version, size_bytes,
				created_at, updated_at, deleted_at
			) VALUES (${id}, ${`${id}.txt`}, 'text/plain', 2, 1, ${NOW}, ${NOW}, ${options.deletedAt ?? null})`;
		if (options.tagId) {
			yield* sql`INSERT INTO file_tags (file_id, tag_id) VALUES (${id}, ${options.tagId})`;
		}
	});

describe('pgvector index', () => {
	it('returns the nearest visible files once per file, honouring tags', async () => {
		const prefix = `vec-${crypto.randomUUID()}`;
		const [near, far, deleted, staleVersion] = [
			`${prefix}-near`,
			`${prefix}-far`,
			`${prefix}-deleted`,
			`${prefix}-stale`
		];
		const tagId = `${prefix}-tag`;
		const result = await run(
			Effect.gen(function* () {
				const sql = yield* PgSql;
				const index = makeVectorIndex(sql, true);
				yield* sql`INSERT INTO tags (id, name, normalized_name, created_at)
					VALUES (${tagId}, ${tagId}, ${tagId}, ${NOW})`;
				yield* seedFile(near, { tagId });
				yield* seedFile(far);
				yield* seedFile(deleted, { deletedAt: NOW });
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
					// Rows for a superseded version never match.
					chunk(staleVersion, 1, 0, 0)
				]);
				// Re-upserting the same key replaces the embedding in place.
				yield* index.upsert([chunk(far, 2, 0, 2)]);
				const query = between(0, 1);
				const all = yield* index.search(query, { now: NOW, tagIds: [] });
				const tagged = yield* index.search(query, {
					now: NOW,
					tagIds: [tagId]
				});
				const none = yield* index.search(null, { now: NOW, tagIds: [] });
				const count = yield* index.count;
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
});
