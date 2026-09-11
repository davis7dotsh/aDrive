import { Effect } from 'effect';
import {
	CurrentTransformer,
	type Statement
} from 'effect/unstable/sql/Statement';
import { describe, expect, it } from 'vitest';
import { PgSql } from './pg';
import {
	fullTextCandidates,
	trigramCandidates,
	type CandidateFilter
} from './search-candidates';
import { refreshSearchDocument } from './search-index';
import { ensureTestOrg, TEST_ORG_ID } from './test/org';
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

const seedTag = (id: string, name = id) =>
	Effect.gen(function* () {
		const sql = yield* PgSql;
		yield* ensureTestOrg(sql);
		yield* sql`INSERT INTO tags (id, org_id, name, normalized_name, created_at)
			VALUES (${id}, ${TEST_ORG_ID}, ${name}, ${name}, ${NOW})`;
	});

const seedFile = (id: string, seed: Seed) =>
	Effect.gen(function* () {
		const sql = yield* PgSql;
		yield* ensureTestOrg(sql);
		yield* sql`INSERT INTO files (
				id, org_id, display_name, content_type, size_bytes, created_at, updated_at,
				deleted_at, expires_at
			) VALUES (
				${id}, ${TEST_ORG_ID}, ${seed.name}, 'text/plain', 1, ${NOW}, ${NOW},
				${seed.deletedAt ?? null}, ${seed.expiresAt ?? null}
			)`;
		yield* sql`INSERT INTO file_versions (
				file_id, org_id, version, r2_key, size_bytes, content_type, created_at, text_content
			) VALUES (${id}, ${TEST_ORG_ID}, 1, ${`v/${id}/1`}, 1, 'text/plain', ${NOW}, ${seed.body ?? ''})`;
		if (seed.tagId) {
			yield* sql`INSERT INTO file_tags (file_id, tag_id) VALUES (${id}, ${seed.tagId})`;
		}
		yield* refreshSearchDocument(sql, id, TEST_ORG_ID);
	});

// Other test files share the database, so only rows seeded here count.
const onlyMine = (
	rows: ReadonlyArray<{ readonly file_id: string }>,
	ids: ReadonlyArray<string>
) => rows.map((row) => row.file_id).filter((id) => ids.includes(id));

const search = (
	kind: 'fullText' | 'trigram',
	query: string,
	filter: CandidateFilter = { orgId: TEST_ORG_ID, now: NOW, tagIds: [] }
) =>
	Effect.gen(function* () {
		const sql = yield* PgSql;
		return yield* kind === 'fullText'
			? fullTextCandidates(sql, query, filter)
			: trigramCandidates(sql, query, filter);
	});

describe('postgres search candidates', () => {
	it('normalizes mixed fields while preserving phrase, OR, NOT and literal queries', async () => {
		const prefix = `sc-normalization-${crypto.randomUUID()}`;
		const tagId = `${prefix}-tag`;
		const [mixed, phrase, separated, confidential, literal] = [
			`${prefix}-mixed`,
			`${prefix}-phrase`,
			`${prefix}-separated`,
			`${prefix}-confidential`,
			`${prefix}-literal`
		];
		const ids = [mixed, phrase, separated, confidential, literal];
		const result = await run(
			Effect.gen(function* () {
				yield* seedTag(tagId, `${prefix} quarterly`);
				yield* seedFile(mixed, {
					name: 'Memo.txt',
					tagId,
					body: 'Annual reports are attached'
				});
				yield* seedFile(phrase, { name: 'Quarterly report' });
				yield* seedFile(separated, {
					name: 'Quarterly financial reports summary.txt'
				});
				yield* seedFile(confidential, {
					name: 'Quarterly report summary.txt',
					body: 'Confidential documents'
				});
				yield* seedFile(literal, { name: 'The document.txt' });
				return {
					mixed: onlyMine(yield* search('fullText', 'quarterly reports'), ids),
					phrase: onlyMine(
						yield* search('fullText', '"quarterly reports"'),
						ids
					),
					reversedPhrase: onlyMine(
						yield* search('fullText', '"report quarterly"'),
						ids
					),
					or: onlyMine(
						yield* search('fullText', '"quarterly reports" OR attachments'),
						ids
					),
					not: onlyMine(
						yield* search('fullText', 'quarterly -confidential'),
						ids
					),
					excludedBody: onlyMine(
						yield* search('fullText', 'quarterly -reports'),
						ids
					),
					literal: onlyMine(yield* search('fullText', 'the'), ids)
				};
			})
		);
		expect(result.mixed.toSorted()).toEqual(
			[mixed, phrase, separated, confidential].toSorted()
		);
		expect(result.phrase.toSorted()).toEqual([phrase, confidential].toSorted());
		expect(result.reversedPhrase).toEqual([]);
		expect(result.or.toSorted()).toEqual(
			[mixed, phrase, confidential].toSorted()
		);
		expect(result.not.toSorted()).toEqual(
			[mixed, phrase, separated].toSorted()
		);
		expect(result.excludedBody).toEqual([]);
		expect(result.literal).toEqual([literal]);
	});

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
							orgId: TEST_ORG_ID,
							now: NOW,
							tagIds: [wanted]
						}),
						all
					),
					trigram: onlyMine(
						yield* search('trigram', 'crowd', {
							orgId: TEST_ORG_ID,
							now: NOW,
							tagIds: [wanted]
						}),
						all
					),
					wrongTag: onlyMine(
						yield* search('fullText', 'haystack', {
							orgId: TEST_ORG_ID,
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

	it('uses the trigram index with the configured cutoff', async () => {
		const id = `sc-index-${crypto.randomUUID()}`;
		const result = await run(
			Effect.gen(function* () {
				const sql = yield* PgSql;
				yield* seedFile(id, { name: 'Quarterly report.pdf' });
				const unrelated = Array.from({ length: 2_000 }, (_, index) => ({
					id: `${id}-unrelated-${index}`,
					org_id: TEST_ORG_ID,
					display_name: `Unrelated photograph ${index}`,
					content_type: 'image/jpeg',
					size_bytes: 1,
					created_at: NOW,
					updated_at: NOW
				}));
				yield* sql`INSERT INTO files ${sql.insert(unrelated)}`;
				yield* sql`INSERT INTO search_documents ${sql.insert(
					unrelated.map((file) => ({
						file_id: file.id,
						org_id: TEST_ORG_ID,
						name: file.display_name
					}))
				)}`;
				// Flush GIN's bulk-insert pending list before measuring its plan.
				yield* sql`VACUUM ANALYZE search_documents`;
				yield* sql`ANALYZE files`;
				return yield* sql.withTransaction(
					Effect.gen(function* () {
						// The unrelated corpus and fresh statistics make this an
						// index-eligibility check, independent of tiny-table costs.
						yield* sql`SET LOCAL enable_seqscan = off`;
						yield* sql`SET LOCAL pg_trgm.word_similarity_threshold = 0.9`;
						let compiled: ReturnType<Statement<unknown>['compile']> | undefined;
						const rows = yield* trigramCandidates(sql, 'reprot', {
							orgId: TEST_ORG_ID,
							now: NOW,
							tagIds: []
						}).pipe(
							Effect.provideService(CurrentTransformer, (statement) => {
								const query = statement.compile();
								if (query[0].includes('word_similarity(')) compiled = query;
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
		expect(result.rows.some((row) => row.file_id === id)).toBe(true);
		expect(result.plan).toContain('search_documents_name_trgm_idx');
	});
});
