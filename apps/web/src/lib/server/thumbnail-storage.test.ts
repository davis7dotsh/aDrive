import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { Effect } from 'effect';
import { afterEach, describe, expect, it } from 'vitest';
import { ensureStorageQuota, type StorageQuotaDatabase } from './storage-quota';
import {
	commitThumbnailStorageCommand,
	thumbnailQuotaDelta,
	thumbnailStorageStateCommand
} from './thumbnail-storage';

const databases: DatabaseSync[] = [];
const migration = (...names: ReadonlyArray<string>) =>
	names
		.map((name) =>
			readFileSync(
				new URL(`../../../migrations/${name}`, import.meta.url),
				'utf8'
			)
		)
		.join('\n');

const makeDatabase = () => {
	const database = new DatabaseSync(':memory:');
	databases.push(database);
	database.exec(
		migration('0001_init.sql', '0003_sites.sql', '0010_thumbnail_storage.sql')
	);
	database
		.prepare(
			`INSERT INTO files (
				id, display_name, content_type, kind, current_version, size_bytes,
				public, is_site, created_at, updated_at, index_state
			) VALUES (?, 'image.jpg', 'image/jpeg', 'file', 1, 80, 1, 0, ?, ?, 'disabled')`
		)
		.run('file-1', '2026-08-13T00:00:00.000Z', '2026-08-13T00:00:00.000Z');
	database
		.prepare(
			`INSERT INTO file_versions (
				file_id, version, r2_key, size_bytes, content_type, created_at
			) VALUES ('file-1', 1, 'v/file-1/one', 80, 'image/jpeg', ?)`
		)
		.run('2026-08-13T00:00:00.000Z');
	return database;
};

const quotaDatabase = (database: DatabaseSync): StorageQuotaDatabase => ({
	prepare: (query) => ({
		first: async <T>() => {
			await Promise.resolve();
			return (database.prepare(query).get() as T | undefined) ?? null;
		}
	})
});

const run = (
	database: DatabaseSync,
	command: ReturnType<typeof commitThumbnailStorageCommand>
) => database.prepare(command.sql).run(...command.bindings);

afterEach(() => {
	for (const database of databases) database.close();
	databases.length = 0;
});

describe('dashboard thumbnail storage', () => {
	it('stops commits after purge claims the source version', () => {
		const database = makeDatabase();
		const state = thumbnailStorageStateCommand('file-1', 1);

		expect(database.prepare(state.sql).get(...state.bindings)).toEqual({
			thumbnail_r2_key: null,
			thumbnail_size_bytes: 0
		});

		database
			.prepare("UPDATE files SET purge_state = 'pending' WHERE id = 'file-1'")
			.run();
		const result = run(
			database,
			commitThumbnailStorageCommand(
				'file-1',
				1,
				'thumbnail/file-1/1/loser.webp',
				20,
				null
			)
		);

		expect(result.changes).toBe(0);
	});

	it('allows previews before a trashed file is purged', () => {
		const database = makeDatabase();
		database
			.prepare("UPDATE files SET deleted_at = '2026-08-13' WHERE id = 'file-1'")
			.run();

		expect(
			run(
				database,
				commitThumbnailStorageCommand(
					'file-1',
					1,
					'thumbnail/file-1/1/trash.webp',
					20,
					null
				)
			).changes
		).toBe(1);
	});

	it("does not let a losing writer replace another writer's thumbnail", () => {
		const database = makeDatabase();
		const winner = run(
			database,
			commitThumbnailStorageCommand(
				'file-1',
				1,
				'thumbnail/file-1/1/winner.webp',
				20,
				null
			)
		);
		const loser = run(
			database,
			commitThumbnailStorageCommand(
				'file-1',
				1,
				'thumbnail/file-1/1/loser.webp',
				20,
				null
			)
		);

		expect(winner.changes).toBe(1);
		expect(loser.changes).toBe(0);
		expect(
			database
				.prepare(
					'SELECT thumbnail_r2_key, thumbnail_size_bytes FROM file_versions'
				)
				.get()
		).toEqual({
			thumbnail_r2_key: 'thumbnail/file-1/1/winner.webp',
			thumbnail_size_bytes: 20
		});
	});

	it('counts derivative bytes against the storage quota', async () => {
		const database = makeDatabase();
		run(
			database,
			commitThumbnailStorageCommand(
				'file-1',
				1,
				'thumbnail/file-1/1/current.webp',
				20,
				null
			)
		);

		await expect(
			Effect.runPromise(ensureStorageQuota(quotaDatabase(database), 105, 6))
		).rejects.toMatchObject({ _tag: 'InvalidRequest', status: 413 });
	});

	it('charges only the growth when replacing missing derivative bytes', () => {
		expect(thumbnailQuotaDelta(20, 24)).toBe(4);
		expect(thumbnailQuotaDelta(20, 16)).toBe(0);
	});
});
