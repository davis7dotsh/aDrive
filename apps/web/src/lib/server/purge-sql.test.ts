import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { purgeCompletionCommands, type PurgeSqlCommand } from './purge-sql';

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
	for (const name of [
		'0001_init.sql',
		'0002_tags_search.sql',
		'0003_sites.sql',
		'0004_auth_ttl_downloads.sql',
		'0005_semantic_lifecycle.sql',
		'0006_index_leases.sql'
	]) {
		database.exec(migration(name));
	}
	return database;
};

const runCommands = (
	database: DatabaseSync,
	commands: ReadonlyArray<PurgeSqlCommand>
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

const seedPurgingFile = (
	database: DatabaseSync,
	fileId: string,
	kind: 'file' | 'site'
) => {
	const now = '2026-07-27T00:00:00.000Z';
	database
		.prepare(
			`INSERT INTO files (
				id, display_name, content_type, kind, current_version, size_bytes,
				public, is_site, created_at, updated_at, deleted_at, purge_at,
				purge_state
			) VALUES (?, ?, ?, ?, 1, 42, 1, ?, ?, ?, ?, ?, 'pending')`
		)
		.run(
			fileId,
			`${kind}-distinctive-name`,
			kind === 'site' ? 'text/html' : 'text/plain',
			kind,
			kind === 'site' ? 1 : 0,
			now,
			now,
			now,
			now
		);
	database
		.prepare(
			`INSERT INTO file_versions (
				file_id, version, r2_key, size_bytes, content_type, created_at,
				text_content
			) VALUES (?, 1, ?, 42, ?, ?, 'distinctive purge body')`
		)
		.run(
			fileId,
			kind === 'site' ? `site-version/${fileId}/1` : `v/${fileId}/1`,
			kind === 'site' ? 'text/html' : 'text/plain',
			now
		);
	database
		.prepare(
			`INSERT INTO tags (id, name, normalized_name, created_at)
			VALUES (?, 'distinctive-purge-tag', ?, ?)`
		)
		.run(`tag-${fileId}`, `distinctive-purge-tag-${fileId}`, now);
	database
		.prepare('INSERT INTO file_tags (file_id, tag_id) VALUES (?, ?)')
		.run(fileId, `tag-${fileId}`);
	database
		.prepare(
			`INSERT INTO files_fts (name, tags, body, file_id, chunk_no)
			VALUES
				(?, 'distinctive-purge-tag', 'distinctive purge body', ?, 0),
				(?, 'distinctive-purge-tag', 'second distinctive body', ?, 1)`
		)
		.run(
			`${kind}-distinctive-name`,
			fileId,
			`${kind}-distinctive-name`,
			fileId
		);
	database
		.prepare(
			`INSERT INTO files_trgm (name, file_id)
			VALUES (?, ?)`
		)
		.run(`${kind}-distinctive-name`, fileId);
	database
		.prepare(
			`INSERT INTO file_chunks (
				vector_id, file_id, version, ordinal, char_start, char_end
			) VALUES
				(?, ?, 1, 0, 0, 10),
				(?, ?, 1, 1, 8, 18)`
		)
		.run(`${fileId}:attempt:0`, fileId, `${fileId}:attempt:1`, fileId);
	if (kind === 'site') {
		database
			.prepare(
				`INSERT INTO site_assets (
					file_id, version, path, r2_key, content_type, size_bytes
				) VALUES (?, 1, 'index.html', ?, 'text/html', 42)`
			)
			.run(fileId, `s/${fileId}/1/index`);
	}
};

const counts = (database: DatabaseSync, fileId: string) =>
	database
		.prepare(
			`SELECT
				(SELECT COUNT(*) FROM files WHERE id = ?) AS files,
				(SELECT COUNT(*) FROM file_versions WHERE file_id = ?) AS versions,
				(SELECT COUNT(*) FROM file_tags WHERE file_id = ?) AS file_tags,
				(SELECT COUNT(*) FROM site_assets WHERE file_id = ?) AS site_assets,
				(SELECT COUNT(*) FROM files_fts WHERE file_id = ?) AS fts,
				(SELECT COUNT(*) FROM files_trgm WHERE file_id = ?) AS trgm,
				(SELECT COUNT(*) FROM file_chunks WHERE file_id = ?) AS chunks,
				(SELECT COUNT(*) FROM pending_vector_deletes
					WHERE vector_id LIKE ?) AS pending_vectors`
		)
		.get(fileId, fileId, fileId, fileId, fileId, fileId, fileId, `${fileId}:%`);

describe('canonical purge completion SQL', () => {
	it.each(['file', 'site'] as const)(
		'keeps %s metadata and search rows before R2 confirmation or on batch failure',
		(kind) => {
			const database = makeDatabase();
			const fileId = `purge-${kind}-failure`;
			seedPurgingFile(database, fileId, kind);
			expect(counts(database, fileId)).toEqual({
				files: 1,
				versions: 1,
				file_tags: 1,
				site_assets: kind === 'site' ? 1 : 0,
				fts: 2,
				trgm: 1,
				chunks: 2,
				pending_vectors: 0
			});

			const commands = purgeCompletionCommands(
				fileId,
				'2026-07-27T00:01:00.000Z'
			);
			const forcedFailure = {
				sql: `INSERT INTO pending_vector_deletes (vector_id, queued_at)
					VALUES (?, 'forced failure')`,
				bindings: [`${fileId}:attempt:0`]
			} satisfies PurgeSqlCommand;
			expect(() =>
				runCommands(database, [
					...commands.slice(0, 3),
					forcedFailure,
					...commands.slice(3)
				])
			).toThrow();
			expect(counts(database, fileId)).toEqual({
				files: 1,
				versions: 1,
				file_tags: 1,
				site_assets: kind === 'site' ? 1 : 0,
				fts: 2,
				trgm: 1,
				chunks: 2,
				pending_vectors: 0
			});
		}
	);

	it.each(['file', 'site'] as const)(
		'atomically removes %s canonical and search rows after R2 confirmation',
		(kind) => {
			const database = makeDatabase();
			const fileId = `purge-${kind}-success`;
			seedPurgingFile(database, fileId, kind);
			const changes = runCommands(
				database,
				purgeCompletionCommands(fileId, '2026-07-27T00:01:00.000Z')
			);
			expect(changes.at(-2)).toBe(1);
			expect(changes.at(-1)).toBe(1);
			expect(counts(database, fileId)).toEqual({
				files: 0,
				versions: 0,
				file_tags: 0,
				site_assets: 0,
				fts: 0,
				trgm: 0,
				chunks: 0,
				pending_vectors: 2
			});
			expect(
				database
					.prepare(
						`SELECT vector_id FROM pending_vector_deletes
						WHERE vector_id LIKE ? ORDER BY vector_id`
					)
					.all(`${fileId}:%`)
			).toEqual([
				{ vector_id: `${fileId}:attempt:0` },
				{ vector_id: `${fileId}:attempt:1` }
			]);
		}
	);

	it.each(['file', 'site'] as const)(
		'makes stale %s completion a no-op when purge ownership is no longer pending',
		(kind) => {
			const database = makeDatabase();
			const fileId = `purge-${kind}-stale`;
			seedPurgingFile(database, fileId, kind);
			database
				.prepare(
					`UPDATE files
					SET purge_state = 'failed', purge_error = 'ownership changed'
					WHERE id = ?`
				)
				.run(fileId);

			const changes = runCommands(
				database,
				purgeCompletionCommands(fileId, '2026-07-27T00:01:00.000Z')
			);

			expect(changes).toEqual([0, 0, 0, 0, 0]);
			expect(counts(database, fileId)).toEqual({
				files: 1,
				versions: 1,
				file_tags: 1,
				site_assets: kind === 'site' ? 1 : 0,
				fts: 2,
				trgm: 1,
				chunks: 2,
				pending_vectors: 0
			});
		}
	);
});
