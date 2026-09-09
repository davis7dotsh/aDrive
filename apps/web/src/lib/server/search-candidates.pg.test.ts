import { Effect } from 'effect';
import { describe, expect, it } from 'vitest';
import { PgSql } from './pg';
import {
	fullTextCandidates,
	trigramCandidates,
	type CandidateFilter
} from './search-candidates';
import { refreshSearchDocument } from './search-index';
import { testPgLayer } from './test/pg';

const NOW = '2026-07-27T00:00:00.000Z';

const run = <A, E>(effect: Effect.Effect<A, E, PgSql>) =>
	Effect.runPromise(effect.pipe(Effect.provide(testPgLayer())));

interface Seed {
	readonly name: string;
	readonly body?: string;
	readonly tagId?: string;
	readonly deletedAt?: string;
	readonly expiresAt?: string;
}

const seedTag = (id: string) =>
	Effect.gen(function* () {
		const sql = yield* PgSql;
		yield* sql`INSERT INTO tags (id, name, normalized_name, created_at)
			VALUES (${id}, ${id}, ${id}, ${NOW})`;
	});

const seedFile = (id: string, seed: Seed) =>
	Effect.gen(function* () {
		const sql = yield* PgSql;
		yield* sql`INSERT INTO files (
				id, display_name, content_type, size_bytes, created_at, updated_at,
				deleted_at, expires_at
			) VALUES (
				${id}, ${seed.name}, 'text/plain', 1, ${NOW}, ${NOW},
				${seed.deletedAt ?? null}, ${seed.expiresAt ?? null}
			)`;
		yield* sql`INSERT INTO file_versions (
				file_id, version, r2_key, size_bytes, content_type, created_at, text_content
			) VALUES (${id}, 1, ${`v/${id}/1`}, 1, 'text/plain', ${NOW}, ${seed.body ?? ''})`;
		if (seed.tagId) {
			yield* sql`INSERT INTO file_tags (file_id, tag_id) VALUES (${id}, ${seed.tagId})`;
		}
		yield* refreshSearchDocument(sql, id);
	});

// Other test files share the database, so only rows seeded here count.
const onlyMine = (
	rows: ReadonlyArray<{ readonly file_id: string }>,
	ids: ReadonlyArray<string>
) => rows.map((row) => row.file_id).filter((id) => ids.includes(id));

const search = (
	kind: 'fullText' | 'trigram',
	query: string,
	filter: CandidateFilter = { now: NOW, tagIds: [] }
) =>
	Effect.gen(function* () {
		const sql = yield* PgSql;
		return yield* kind === 'fullText'
			? fullTextCandidates(sql, query, filter)
			: trigramCandidates(sql, query, filter);
	});

describe('postgres search candidates', () => {
	it('ranks a name match above a body match and stems body terms', async () => {
		const prefix = `sc-${crypto.randomUUID()}`;
		const named = `${prefix}-named`;
		const bodied = `${prefix}-bodied`;
		const other = `${prefix}-other`;
		const result = await run(
			Effect.gen(function* () {
				yield* seedFile(named, { name: 'needle report.pdf', body: 'hay' });
				yield* seedFile(bodied, {
					name: 'hay.pdf',
					body: 'needle needle needle in the third quarter'
				});
				yield* seedFile(other, { name: 'other.pdf', body: 'nothing here' });
				return {
					needle: onlyMine(yield* search('fullText', 'needle'), [
						named,
						bodied,
						other
					]),
					stemmed: onlyMine(yield* search('fullText', 'quarterly needles'), [
						named,
						bodied,
						other
					])
				};
			})
		);
		expect(result.needle).toEqual([named, bodied]);
		expect(result.stemmed).toEqual([bodied]);
	});

	it('excludes files outside the selected tags and invisible files', async () => {
		const prefix = `sc-${crypto.randomUUID()}`;
		const wanted = `${prefix}-wanted`;
		const wrong = `${prefix}-wrong`;
		const ids = Array.from({ length: 60 }, (_, index) => `${prefix}-${index}`);
		const eligible = `${prefix}-zz-eligible`;
		const result = await run(
			Effect.gen(function* () {
				yield* seedTag(wanted);
				yield* seedTag(wrong);
				// Sixty higher-sorting rows that must be filtered before the
				// LIMIT, otherwise the single eligible row never surfaces.
				for (const [index, id] of ids.entries()) {
					yield* seedFile(id, {
						name: 'crowd.txt',
						body: 'crowded haystack',
						tagId: index < 40 ? wanted : wrong,
						deletedAt: index < 20 ? NOW : undefined,
						expiresAt: index >= 20 && index < 40 ? NOW : undefined
					});
				}
				yield* seedFile(eligible, {
					name: 'crowd.txt',
					body: 'crowded haystack',
					tagId: wanted
				});
				const all = [...ids, eligible];
				return {
					fullText: onlyMine(
						yield* search('fullText', 'haystack', {
							now: NOW,
							tagIds: [wanted]
						}),
						all
					),
					trigram: onlyMine(
						yield* search('trigram', 'crowd', { now: NOW, tagIds: [wanted] }),
						all
					),
					wrongTag: onlyMine(
						yield* search('fullText', 'haystack', {
							now: NOW,
							tagIds: [wrong]
						}),
						all
					)
				};
			})
		);
		expect(result.fullText).toEqual([eligible]);
		expect(result.trigram).toEqual([eligible]);
		// The other tag sees only its own visible rows, never the eligible one.
		expect(result.wrongTag).toEqual(ids.slice(40));
	});

	it('catches a typo in the file name through trigrams', async () => {
		const prefix = `sc-${crypto.randomUUID()}`;
		const report = `${prefix}-report`;
		const notes = `${prefix}-notes`;
		const result = await run(
			Effect.gen(function* () {
				yield* seedFile(report, { name: 'Quarterly report.pdf' });
				yield* seedFile(notes, { name: 'Meeting notes.txt' });
				return {
					typo: onlyMine(yield* search('trigram', 'reprot'), [report, notes]),
					fullText: onlyMine(yield* search('fullText', 'reprot'), [
						report,
						notes
					])
				};
			})
		);
		expect(result.typo).toEqual([report]);
		expect(result.fullText).toEqual([]);
	});
});
