import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { reciprocalRankFusion } from './search-ranking';
import {
	eligibleSemanticCommand,
	rankedSearchCommand,
	type SearchCommand,
	type SearchIndex
} from './search-candidates';

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
	database.exec(
		`INSERT INTO tags (id, name, normalized_name, created_at)
		VALUES
			('wanted', 'wanted', 'wanted', '2026-07-27T00:00:00.000Z'),
			('wrong', 'wrong', 'wrong', '2026-07-27T00:00:00.000Z')`
	);
	return database;
};

const insertFile = (
	database: DatabaseSync,
	id: string,
	options: {
		readonly tagId: 'wanted' | 'wrong';
		readonly deletedAt?: string;
		readonly expiresAt?: string;
	}
) => {
	const now = '2026-07-27T00:00:00.000Z';
	database
		.prepare(
			`INSERT INTO files (
				id, display_name, content_type, kind, current_version, size_bytes,
				public, is_site, created_at, updated_at, deleted_at, expires_at
			) VALUES (?, 'needle', 'text/plain', 'file', 1, 6, 1, 0, ?, ?, ?, ?)`
		)
		.run(id, now, now, options.deletedAt ?? null, options.expiresAt ?? null);
	database
		.prepare(
			`INSERT INTO file_versions (
				file_id, version, r2_key, size_bytes, content_type, created_at,
				text_content
			) VALUES (?, 1, ?, 6, 'text/plain', ?, 'needle')`
		)
		.run(id, `v/${id}/1`, now);
	database
		.prepare('INSERT INTO file_tags (file_id, tag_id) VALUES (?, ?)')
		.run(id, options.tagId);
	database
		.prepare(
			`INSERT INTO files_fts (name, tags, body, file_id, chunk_no)
			VALUES ('needle', ?, 'needle', ?, 0)`
		)
		.run(options.tagId, id);
	database
		.prepare(`INSERT INTO files_trgm (name, file_id) VALUES ('needle', ?)`)
		.run(id);
};

const run = (database: DatabaseSync, command: SearchCommand) =>
	database
		.prepare(command.sql)
		.all(...command.bindings)
		.map((row) => {
			if (typeof row.file_id !== 'string') {
				throw new Error('Search fixture returned an invalid file id');
			}
			return { file_id: row.file_id };
		});

const seedCrowdingFixture = (database: DatabaseSync) => {
	const ineligibleIds: string[] = [];
	for (let index = 0; index < 100; index += 1) {
		const id = `a-${index.toString().padStart(3, '0')}`;
		ineligibleIds.push(id);
		insertFile(database, id, {
			tagId: index < 40 ? 'wanted' : 'wrong',
			deletedAt: index < 20 ? '2026-07-26T00:00:00.000Z' : undefined,
			expiresAt:
				index >= 20 && index < 40 ? '2026-07-26T00:00:00.000Z' : undefined
		});
	}
	insertFile(database, 'z-eligible', { tagId: 'wanted' });
	return ineligibleIds;
};

describe('pre-limit search candidate filtering', () => {
	it.each([
		['files_fts', '"needle"*'],
		['files_trgm', '"nee" OR "eed" OR "edl" OR "dle"']
	] as const)(
		'finds an eligible lower-ranked row from %s after over 50 ineligible matches',
		(index: SearchIndex, match: string) => {
			const database = makeDatabase();
			seedCrowdingFixture(database);
			expect(
				run(
					database,
					rankedSearchCommand(index, match, '2026-07-27T00:00:00.000Z', [
						'wanted'
					])
				).map((row) => row.file_id)
			).toEqual(['z-eligible']);
		}
	);

	it('filters semantic eligibility before fusion so wrong tags cannot crowd out keywords', () => {
		const database = makeDatabase();
		const ineligibleIds = seedCrowdingFixture(database);
		const semantic = run(
			database,
			eligibleSemanticCommand(
				[...ineligibleIds, 'z-eligible'],
				'2026-07-27T00:00:00.000Z',
				['wanted']
			)
		).map((row) => ({ fileId: row.file_id }));
		expect(semantic).toEqual([{ fileId: 'z-eligible' }]);

		const keyword = [
			{ fileId: 'z-eligible' },
			...Array.from({ length: 49 }, (_, index) => ({
				fileId: `keyword-${index}`
			}))
		];
		const fused = reciprocalRankFusion({
			keyword: { results: keyword, weight: 1 },
			trigram: { results: [], weight: 0.5 },
			semantic: { results: semantic, weight: 1 }
		});
		expect(fused).toHaveLength(50);
		expect(fused.every((row) => !row.fileId.startsWith('a-'))).toBe(true);
		expect(fused[0]?.fileId).toBe('z-eligible');
	});
});
