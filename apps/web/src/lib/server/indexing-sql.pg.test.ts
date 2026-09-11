import { Effect } from 'effect';
import { describe, expect, it } from 'vitest';
import {
	claimIndex,
	finishKeywordOnly,
	recordIndexFailure,
	semanticCommit,
	storeExtractedText,
	type IndexLease,
	type VectorChunk
} from './indexing-sql';
import { PgSql } from './pg';
import { MAX_INDEX_ATTEMPTS, indexFailureDisposition } from './semantic-policy';
import { testPgLayer } from './test/pg';

const NOW = '2026-07-27T00:00:00.000Z';
const LEASE_UNTIL = '2026-07-27T00:05:00.000Z';

const run = <A, E>(effect: Effect.Effect<A, E, PgSql>) =>
	Effect.runPromise(effect.pipe(Effect.provide(testPgLayer())));

const seedVersion = (fileId: string, version: number, attempts = 0) =>
	Effect.gen(function* () {
		const sql = yield* PgSql;
		if (version === 1) {
			yield* sql`INSERT INTO files (
					id, display_name, content_type, size_bytes, created_at, updated_at,
					index_attempts
				) VALUES (${fileId}, 'race.txt', 'text/plain', 4, ${NOW}, ${NOW}, ${attempts})`;
		} else {
			yield* sql`UPDATE files
				SET current_version = ${version}, index_state = 'pending', index_cursor = 0,
					index_attempts = 0, index_error = NULL, index_next_run_at = NULL,
					index_lease_token = NULL
				WHERE id = ${fileId}`;
		}
		yield* sql`INSERT INTO file_versions (
				file_id, version, r2_key, size_bytes, content_type, created_at
			) VALUES (${fileId}, ${version}, ${`v/${fileId}/${version}`}, 4, 'text/plain', ${NOW})`;
	});

const lease = (
	fileId: string,
	version: number,
	attempt: number,
	tokenCharacter: string
) =>
	({
		fileId,
		version,
		attempt,
		token: tokenCharacter.repeat(22)
	}) satisfies IndexLease;

const claim = (value: IndexLease) =>
	Effect.flatMap(PgSql, (sql) =>
		claimIndex(sql, value, NOW, LEASE_UNTIL, MAX_INDEX_ATTEMPTS)
	);

const unitVector = (axis: number) =>
	Array.from({ length: 384 }, (_, index) => (index === axis ? 1 : 0));

const chunksFor = (value: IndexLease, count: number): VectorChunk[] =>
	Array.from({ length: count }, (_, ordinal) => ({
		fileId: value.fileId,
		version: value.version,
		ordinal,
		charStart: ordinal * 10,
		charEnd: ordinal * 10 + 10,
		values: unitVector(ordinal)
	}));

const fileState = (fileId: string) =>
	Effect.flatMap(PgSql, (sql) =>
		Effect.map(
			sql<{
				current_version: number;
				index_state: string;
				indexed_version: number | null;
				index_cursor: number;
				index_attempts: number;
				index_error: string | null;
				index_next_run_at: string | null;
				index_lease_token: string | null;
			}>`SELECT current_version, index_state, indexed_version, index_cursor,
					index_attempts, index_error, index_next_run_at, index_lease_token
				FROM files WHERE id = ${fileId}`,
			(rows) => rows[0]
		)
	);

const chunkRows = (fileId: string) =>
	Effect.flatMap(
		PgSql,
		(sql) =>
			sql<{ version: number; ordinal: number; has_embedding: boolean }>`
				SELECT version, ordinal, embedding IS NOT NULL AS has_embedding
				FROM file_chunks WHERE file_id = ${fileId}
				ORDER BY version, ordinal`
	);

describe('lease-guarded indexing SQL on postgres', () => {
	it('claims a job once and refuses a second claim for the same attempt', async () => {
		const fileId = `ix-${crypto.randomUUID()}`;
		const result = await run(
			Effect.gen(function* () {
				yield* seedVersion(fileId, 1);
				const first = yield* claim(lease(fileId, 1, 1, 'A'));
				const again = yield* claim(lease(fileId, 1, 1, 'B'));
				return { first, again, state: yield* fileState(fileId) };
			})
		);
		expect(result.first).toBe(true);
		expect(result.again).toBe(false);
		expect(result.state).toMatchObject({
			index_state: 'running',
			index_attempts: 1,
			index_lease_token: 'A'.repeat(22),
			index_next_run_at: LEASE_UNTIL
		});
	});

	it('stores extracted text under the lease and ignores a stale writer', async () => {
		const fileId = `ix-${crypto.randomUUID()}`;
		const held = lease(fileId, 1, 1, 'C');
		const stale = lease(fileId, 1, 1, 'D');
		const result = await run(
			Effect.gen(function* () {
				const sql = yield* PgSql;
				yield* seedVersion(fileId, 1);
				yield* claim(held);
				const stored = yield* storeExtractedText(sql, held, 'version one');
				const ignored = yield* storeExtractedText(sql, stale, 'hijacked');
				const [version] = yield* sql<{ text_content: string | null }>`
					SELECT text_content FROM file_versions WHERE file_id = ${fileId} AND version = 1`;
				const [document] = yield* sql<{ body: string }>`
					SELECT body FROM search_documents WHERE file_id = ${fileId}`;
				const finished = yield* finishKeywordOnly(sql, held);
				return {
					stored,
					ignored,
					text: version?.text_content,
					body: document?.body,
					finished,
					state: yield* fileState(fileId)
				};
			})
		);
		expect(result).toMatchObject({
			stored: true,
			ignored: false,
			text: 'version one',
			body: 'version one',
			finished: true
		});
		expect(result.state).toMatchObject({
			index_state: 'disabled',
			index_cursor: 1,
			index_attempts: 0,
			index_lease_token: null
		});
	});

	it('stores NUL-containing text and completes semantic indexing', async () => {
		const fileId = `ix-${crypto.randomUUID()}`;
		const held = lease(fileId, 1, 1, 'N');
		const result = await run(
			Effect.gen(function* () {
				const sql = yield* PgSql;
				yield* seedVersion(fileId, 1);
				yield* claim(held);
				const stored = yield* storeExtractedText(
					sql,
					held,
					'\u0000Quarterly re\u0000port\nCafé 😀\u0000'
				);
				const [version] = yield* sql<{ text_content: string }>`
					SELECT text_content FROM file_versions WHERE file_id = ${fileId}`;
				const [document] = yield* sql<{ body: string; hit: boolean }>`
					SELECT body, tsv @@ websearch_to_tsquery('english', 'quarterly report') AS hit
					FROM search_documents WHERE file_id = ${fileId}`;
				const committed = yield* semanticCommit(sql, held, chunksFor(held, 1));
				return {
					stored,
					version,
					document,
					committed,
					state: yield* fileState(fileId)
				};
			})
		);
		expect(result.stored).toBe(true);
		expect(result.version?.text_content).toBe('Quarterly report\nCafé 😀');
		expect(result.document).toEqual({
			body: 'Quarterly report\nCafé 😀',
			hit: true
		});
		expect(result.committed).toBe(true);
		expect(result.state).toMatchObject({
			index_state: 'ready',
			index_lease_token: null
		});
	});

	it('keeps v2 authoritative when a stale v1 commit arrives late', async () => {
		const fileId = `ix-${crypto.randomUUID()}`;
		const v1 = lease(fileId, 1, 1, 'E');
		const v2 = lease(fileId, 2, 1, 'F');
		const result = await run(
			Effect.gen(function* () {
				const sql = yield* PgSql;
				yield* seedVersion(fileId, 1);
				yield* claim(v1);
				yield* storeExtractedText(sql, v1, 'version one');
				// A leftover v1 chunk without an embedding must disappear
				// when v2 commits.
				yield* sql`INSERT INTO file_chunks (file_id, version, ordinal, char_start, char_end)
					VALUES (${fileId}, 1, 7, 0, 1)`;

				yield* seedVersion(fileId, 2);
				yield* claim(v2);
				yield* storeExtractedText(sql, v2, 'version two');
				const committed = yield* semanticCommit(sql, v2, chunksFor(v2, 2));
				const staleCommit = yield* semanticCommit(sql, v1, chunksFor(v1, 3));
				const staleFailure = yield* recordIndexFailure(sql, v1, {
					state: 'failed',
					error: 'late stale v1 failure',
					nextRunAt: null
				});
				return {
					committed,
					staleCommit,
					staleFailure,
					state: yield* fileState(fileId),
					chunks: yield* chunkRows(fileId)
				};
			})
		);
		expect(result).toMatchObject({
			committed: true,
			staleCommit: false,
			staleFailure: false
		});
		expect(result.state).toMatchObject({
			current_version: 2,
			index_state: 'ready',
			indexed_version: 2,
			index_cursor: 2,
			index_error: null,
			index_lease_token: null
		});
		expect(result.chunks).toEqual([
			{ version: 2, ordinal: 0, has_embedding: true },
			{ version: 2, ordinal: 1, has_embedding: true }
		]);
	});

	it('stops retrying after the final attempt fails', async () => {
		const fileId = `ix-${crypto.randomUUID()}`;
		const last = lease(fileId, 1, MAX_INDEX_ATTEMPTS, 'G');
		const result = await run(
			Effect.gen(function* () {
				const sql = yield* PgSql;
				yield* seedVersion(fileId, 1, MAX_INDEX_ATTEMPTS - 1);
				const claimed = yield* claim(last);
				const recorded = yield* recordIndexFailure(sql, last, {
					...indexFailureDisposition(last.attempt),
					error: 'embedding service down'
				});
				const retried = yield* claim(
					lease(fileId, 1, MAX_INDEX_ATTEMPTS + 1, 'H')
				);
				return { claimed, recorded, retried, state: yield* fileState(fileId) };
			})
		);
		expect(result).toMatchObject({
			claimed: true,
			recorded: true,
			retried: false
		});
		expect(result.state).toMatchObject({
			index_state: 'failed',
			index_attempts: MAX_INDEX_ATTEMPTS,
			index_error: 'embedding service down',
			index_next_run_at: null,
			index_lease_token: null
		});
	});
});
