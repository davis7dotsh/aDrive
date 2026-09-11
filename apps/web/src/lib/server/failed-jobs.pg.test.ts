import { Effect } from 'effect';
import { describe, expect, it } from 'vitest';
import { listFailedJobs, recordFailedJob } from './failed-jobs';
import { PgSql } from './pg';
import { ensureTestOrg, TEST_ORG_ID } from './test/org';
import { testPgLayer } from './test/pg';

const run = <A, E>(effect: Effect.Effect<A, E, PgSql>) =>
	Effect.runPromise(effect.pipe(Effect.provide(testPgLayer())));

describe('failed jobs on postgres', () => {
	it('records a dead letter once, keyed by message id, and lists it for its org', async () => {
		const id = `dead-${crypto.randomUUID()}`;
		const body = {
			kind: 'purge',
			orgId: TEST_ORG_ID,
			fileId: `file-${id}`
		};
		const result = await run(
			Effect.gen(function* () {
				const sql = yield* PgSql;
				yield* ensureTestOrg(sql);
				const first = yield* recordFailedJob(sql, {
					id,
					body,
					attempts: 5,
					error: 'Retries exhausted on adrive-jobs-dlq'
				});
				const again = yield* recordFailedJob(sql, {
					id,
					body,
					attempts: 6,
					error: 'duplicate delivery'
				});
				const listed = yield* listFailedJobs(sql, TEST_ORG_ID);
				return { first, again, listed };
			})
		);
		expect(result.first).toEqual({
			orgId: TEST_ORG_ID,
			kind: 'purge',
			recorded: true
		});
		expect(result.again.recorded).toBe(false);
		const row = result.listed.find((job) => job.id === id);
		expect(row).toMatchObject({
			kind: 'purge',
			payload: body,
			error: 'Retries exhausted on adrive-jobs-dlq',
			attempts: 5,
			resolvedAt: null
		});
	});

	it('keeps a body that is not a job, with no org', async () => {
		const id = `dead-${crypto.randomUUID()}`;
		const result = await run(
			Effect.gen(function* () {
				const sql = yield* PgSql;
				const recorded = yield* recordFailedJob(sql, {
					id,
					body: { kind: 'nope' },
					attempts: 1,
					error: 'undecodable'
				});
				const rows = yield* sql<{ org_id: string | null; kind: string }>`
					SELECT org_id, kind FROM failed_jobs WHERE id = ${id}`;
				return { recorded, rows };
			})
		);
		expect(result.recorded).toEqual({
			orgId: null,
			kind: 'invalid',
			recorded: true
		});
		expect(result.rows).toEqual([{ org_id: null, kind: 'invalid' }]);
	});
});
