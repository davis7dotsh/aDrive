import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import {
	claimIndexCommand,
	extractedTextCommands,
	indexFailureCommands,
	semanticCommitCommands,
	type IndexLease,
	type SqlCommand,
	vectorDeleteFailureCommand,
	vectorDeleteSuccessCommand
} from './indexing-sql';
import {
	MAX_INDEX_ATTEMPTS,
	chunkSearchText,
	vectorIdForChunk
} from './semantic-policy';
import { searchTextLimit } from './search-text';

const migration = (name: string) =>
	readFileSync(new URL(`../../../migrations/${name}`, import.meta.url), 'utf8');

const databases: DatabaseSync[] = [];

afterEach(() => {
	for (const database of databases) database.close();
	databases.length = 0;
});

const makeDatabase = () => {
	const database = new DatabaseSync(':memory:');
	databases.push(database);
	database.exec(migration('0001_init.sql'));
	database.exec(migration('0002_tags_search.sql'));
	database.exec(migration('0005_semantic_lifecycle.sql'));
	database.exec(migration('0006_index_leases.sql'));
	return database;
};

const runCommands = (
	database: DatabaseSync,
	commands: ReadonlyArray<SqlCommand>
) => {
	database.exec('BEGIN');
	try {
		const changes = commands.map((command) =>
			Number(database.prepare(command.sql).run(...command.bindings).changes)
		);
		database.exec('COMMIT');
		return changes;
	} catch (cause) {
		database.exec('ROLLBACK');
		throw cause;
	}
};

const seedVersion = (
	database: DatabaseSync,
	fileId: string,
	version: number,
	state: 'pending' | 'running' = 'pending'
) => {
	const now = '2026-07-27T00:00:00.000Z';
	if (version === 1) {
		database
			.prepare(
				`INSERT INTO files (
					id, display_name, content_type, kind, current_version, size_bytes,
					public, is_site, created_at, updated_at, index_state
				) VALUES (?, 'race.txt', 'text/plain', 'file', 1, 4, 1, 0, ?, ?, ?)`
			)
			.run(fileId, now, now, state);
	} else {
		database
			.prepare(
				`UPDATE files
				SET current_version = ?, index_state = ?, index_cursor = 0,
					index_attempts = 0, index_error = NULL, index_next_run_at = NULL,
					index_lease_token = NULL
				WHERE id = ?`
			)
			.run(version, state, fileId);
	}
	database
		.prepare(
			`INSERT INTO file_versions (
				file_id, version, r2_key, size_bytes, content_type, created_at
			) VALUES (?, ?, ?, 4, 'text/plain', ?)`
		)
		.run(fileId, version, `v/${fileId}/${version}`, now);
};

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

const claim = (database: DatabaseSync, value: IndexLease) =>
	runCommands(database, [
		claimIndexCommand(
			value,
			'2026-07-27T00:00:00.000Z',
			'2026-07-27T00:05:00.000Z',
			MAX_INDEX_ATTEMPTS
		)
	]);

const chunksAndIds = (value: IndexLease, text: string) => {
	const chunks = chunkSearchText('race.txt', text);
	return {
		chunks,
		vectorIds: chunks.map((chunk) =>
			vectorIdForChunk(value.fileId, value.token, chunk.ordinal)
		)
	};
};

describe('lease-guarded semantic indexing SQL', () => {
	it('keeps v2 authoritative when v1 resumes after its vector upsert', () => {
		const database = makeDatabase();
		const fileId = '550e8400-e29b-41d4-a716-446655440000';
		seedVersion(database, fileId, 1);
		const v1 = lease(fileId, 1, 1, 'A');
		expect(claim(database, v1)).toEqual([1]);
		expect(
			runCommands(database, extractedTextCommands(v1, 'version one'))[1]
		).toBe(1);
		const v1Index = chunksAndIds(v1, 'version one');

		seedVersion(database, fileId, 2);
		const v2 = lease(fileId, 2, 1, 'B');
		expect(claim(database, v2)).toEqual([1]);
		expect(
			runCommands(database, extractedTextCommands(v2, 'version two'))[1]
		).toBe(1);
		const v2Index = chunksAndIds(v2, 'version two');
		const v2Commit = runCommands(
			database,
			semanticCommitCommands(
				v2,
				v2Index.chunks,
				v2Index.vectorIds,
				'2026-07-27T00:01:00.000Z'
			)
		);
		expect(v2Commit.at(-1)).toBe(1);

		const staleCommit = runCommands(
			database,
			semanticCommitCommands(
				v1,
				v1Index.chunks,
				v1Index.vectorIds,
				'2026-07-27T00:02:00.000Z'
			)
		);
		expect(staleCommit.at(-1)).toBe(0);
		expect(
			database
				.prepare(
					`SELECT current_version, index_state, indexed_version
					FROM files WHERE id = ?`
				)
				.get(fileId)
		).toEqual({
			current_version: 2,
			index_state: 'ready',
			indexed_version: 2
		});
		expect(
			database
				.prepare(
					'SELECT vector_id FROM file_chunks WHERE file_id = ? ORDER BY ordinal'
				)
				.all(fileId)
		).toEqual(v2Index.vectorIds.map((vector_id) => ({ vector_id })));
		expect(
			database
				.prepare(
					'SELECT vector_id FROM pending_vector_deletes ORDER BY vector_id'
				)
				.all()
		).toEqual(
			[...v1Index.vectorIds].sort().map((vector_id) => ({ vector_id }))
		);
	});

	it('queues only stale v1 attempt vectors without changing running or ready v2', () => {
		const database = makeDatabase();
		const fileId = '550e8400-e29b-41d4-a716-446655440001';
		seedVersion(database, fileId, 1);
		const v1 = lease(fileId, 1, 1, 'C');
		expect(claim(database, v1)).toEqual([1]);
		const v1Index = chunksAndIds(v1, 'version one');

		seedVersion(database, fileId, 2);
		const v2 = lease(fileId, 2, 1, 'D');
		expect(claim(database, v2)).toEqual([1]);
		const staleWhileRunning = runCommands(
			database,
			indexFailureCommands(
				v1,
				v1Index.vectorIds,
				{
					state: 'pending',
					error: 'stale v1 failure',
					nextRunAt: '2026-07-27T00:10:00.000Z'
				},
				'2026-07-27T00:01:00.000Z'
			)
		);
		expect(staleWhileRunning.at(-1)).toBe(0);
		expect(
			database
				.prepare(
					`SELECT index_state, index_lease_token
					FROM files WHERE id = ?`
				)
				.get(fileId)
		).toEqual({
			index_state: 'running',
			index_lease_token: v2.token
		});

		runCommands(database, extractedTextCommands(v2, 'version two'));
		const v2Index = chunksAndIds(v2, 'version two');
		runCommands(
			database,
			semanticCommitCommands(
				v2,
				v2Index.chunks,
				v2Index.vectorIds,
				'2026-07-27T00:02:00.000Z'
			)
		);
		const staleWhileReady = runCommands(
			database,
			indexFailureCommands(
				v1,
				v1Index.vectorIds,
				{
					state: 'failed',
					error: 'late stale v1 failure',
					nextRunAt: null
				},
				'2026-07-27T00:03:00.000Z'
			)
		);
		expect(staleWhileReady.at(-1)).toBe(0);
		expect(
			database
				.prepare(
					`SELECT index_state, indexed_version, index_error
					FROM files WHERE id = ?`
				)
				.get(fileId)
		).toEqual({
			index_state: 'ready',
			indexed_version: 2,
			index_error: null
		});
		expect(
			database
				.prepare(
					'SELECT vector_id FROM pending_vector_deletes ORDER BY vector_id'
				)
				.all()
		).toEqual(
			[...v1Index.vectorIds].sort().map((vector_id) => ({ vector_id }))
		);
	});

	it('uses bounded statement counts for max text and vector delete drains', () => {
		const database = makeDatabase();
		const fileId = '550e8400-e29b-41d4-a716-446655440002';
		seedVersion(database, fileId, 1);
		const attempt = lease(fileId, 1, 1, 'E');
		claim(database, attempt);
		database
			.prepare(
				`INSERT INTO file_chunks (
					vector_id, file_id, version, ordinal, char_start, char_end
				) VALUES ('old-same-version-vector', ?, 1, 0, 0, 1)`
			)
			.run(fileId);
		const index = chunksAndIds(attempt, 'a'.repeat(searchTextLimit));
		const commit = semanticCommitCommands(
			attempt,
			index.chunks,
			index.vectorIds,
			'2026-07-27T00:01:00.000Z'
		);
		expect(index.chunks.length).toBeGreaterThan(30);
		expect(commit).toHaveLength(5);
		expect(runCommands(database, commit).at(-1)).toBe(1);
		expect(
			database.prepare('SELECT COUNT(*) AS count FROM file_chunks').get()
		).toEqual({ count: index.chunks.length });
		expect(
			database
				.prepare(
					`SELECT COUNT(*) AS count FROM pending_vector_deletes
					WHERE vector_id = 'old-same-version-vector'`
				)
				.get()
		).toEqual({ count: 1 });

		const pending = Array.from({ length: 100 }, (_, index) => ({
			vectorId: `delete-${index}`,
			nextRunAt: '2026-07-27T00:10:00.000Z'
		}));
		const insert = database.prepare(
			`INSERT INTO pending_vector_deletes (vector_id, queued_at)
			VALUES (?, '2026-07-27T00:00:00.000Z')`
		);
		for (const row of pending) insert.run(row.vectorId);
		expect(
			runCommands(database, [
				vectorDeleteFailureCommand(pending, 'temporary delete failure')
			])
		).toEqual([100]);
		expect(
			database
				.prepare(
					`SELECT COUNT(*) AS count FROM pending_vector_deletes
					WHERE attempts = 1 AND last_error = 'temporary delete failure'`
				)
				.get()
		).toEqual({ count: 100 });
		expect(
			runCommands(database, [
				vectorDeleteSuccessCommand(pending.map((row) => row.vectorId))
			])
		).toEqual([100]);
	});
});
