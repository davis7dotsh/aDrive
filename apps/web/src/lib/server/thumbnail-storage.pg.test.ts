import { Effect } from 'effect';
import { describe, expect, it } from 'vitest';
import { PgSql } from './pg';
import { ensureTestOrg, TEST_ORG_ID } from './test/org';
import { testPgLayer } from './test/pg';
import {
	commitThumbnailStorage,
	thumbnailQuotaDelta,
	thumbnailStorageState
} from './thumbnail-storage';

const run = <A, E>(effect: Effect.Effect<A, E, PgSql>) =>
	Effect.runPromise(effect.pipe(Effect.provide(testPgLayer())));

const seedImage = (fileId: string) =>
	Effect.gen(function* () {
		const sql = yield* PgSql;
		const now = '2026-08-13T00:00:00.000Z';
		yield* ensureTestOrg(sql);
		yield* sql`
			INSERT INTO files (
				id, org_id, display_name, content_type, kind, current_version, size_bytes,
				public, is_site, created_at, updated_at, index_state
			) VALUES (
				${fileId}, ${TEST_ORG_ID}, 'image.jpg', 'image/jpeg', 'file', 1, 80, true, false,
				${now}, ${now}, 'disabled'
			)`;
		yield* sql`
			INSERT INTO file_versions (
				file_id, org_id, version, r2_key, size_bytes, content_type, created_at
			) VALUES (${fileId}, ${TEST_ORG_ID}, 1, ${`v/${fileId}/one`}, 80, 'image/jpeg', ${now})`;
	});

describe('dashboard thumbnail storage on postgres', () => {
	it('stops commits after purge claims the source version', async () => {
		const fileId = `thumb-purge-${crypto.randomUUID()}`;
		const result = await run(
			Effect.gen(function* () {
				const sql = yield* PgSql;
				yield* seedImage(fileId);
				const initial = yield* thumbnailStorageState(sql, fileId, 1);
				yield* sql`UPDATE files SET purge_state = 'pending' WHERE id = ${fileId}`;
				const committed = yield* commitThumbnailStorage(
					sql,
					fileId,
					1,
					`thumbnail/${fileId}/1/loser.webp`,
					20,
					null
				);
				const claimed = yield* thumbnailStorageState(sql, fileId, 1);
				return { initial, committed, claimed };
			})
		);
		expect(result.initial).toEqual({
			thumbnail_r2_key: null,
			thumbnail_size_bytes: 0
		});
		expect(result.committed).toBe(false);
		expect(result.claimed).toBeNull();
	});

	it('allows previews before a trashed file is purged', async () => {
		const fileId = `thumb-trash-${crypto.randomUUID()}`;
		const committed = await run(
			Effect.gen(function* () {
				const sql = yield* PgSql;
				yield* seedImage(fileId);
				yield* sql`UPDATE files SET deleted_at = '2026-08-13T00:00:00.000Z' WHERE id = ${fileId}`;
				return yield* commitThumbnailStorage(
					sql,
					fileId,
					1,
					`thumbnail/${fileId}/1/trash.webp`,
					20,
					null
				);
			})
		);
		expect(committed).toBe(true);
	});

	it("does not let a losing writer replace another writer's thumbnail", async () => {
		const fileId = `thumb-race-${crypto.randomUUID()}`;
		const result = await run(
			Effect.gen(function* () {
				const sql = yield* PgSql;
				yield* seedImage(fileId);
				const winner = yield* commitThumbnailStorage(
					sql,
					fileId,
					1,
					`thumbnail/${fileId}/1/winner.webp`,
					20,
					null
				);
				const loser = yield* commitThumbnailStorage(
					sql,
					fileId,
					1,
					`thumbnail/${fileId}/1/loser.webp`,
					20,
					null
				);
				const state = yield* thumbnailStorageState(sql, fileId, 1);
				return { winner, loser, state };
			})
		);
		expect(result.winner).toBe(true);
		expect(result.loser).toBe(false);
		expect(result.state).toEqual({
			thumbnail_r2_key: `thumbnail/${fileId}/1/winner.webp`,
			thumbnail_size_bytes: 20
		});
	});

	it('charges only the growth when replacing missing derivative bytes', () => {
		expect(thumbnailQuotaDelta(20, 24)).toBe(4);
		expect(thumbnailQuotaDelta(20, 16)).toBe(0);
	});
});
