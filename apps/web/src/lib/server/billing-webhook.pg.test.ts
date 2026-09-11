import { Effect } from 'effect';
import { Client } from 'pg';
import { describe, expect, it, vi } from 'vitest';
import { reconcileOrgPlan } from './billing-webhook';
import { StorageError } from './errors';
import { PgSql } from './pg';
import { TEST_DATABASE_URL } from './test/database';
import { testPgLayer } from './test/pg';
import { autumnNull, type AutumnClientShape } from './services/autumn';

const setup = async (getPlan: AutumnClientShape['getPlan']) => {
	const orgId = `billing-webhook-${crypto.randomUUID()}`;
	const control = new Client({ connectionString: TEST_DATABASE_URL });
	await control.connect();
	await control.query(
		'INSERT INTO orgs (id, slug, name, plan) VALUES ($1, $1, $1, $2)',
		[orgId, 'pro']
	);
	const autumn = { ...autumnNull, enabled: true, getPlan };
	return {
		orgId,
		control,
		run: (id = orgId) =>
			Effect.runPromise(
				Effect.flatMap(PgSql, (sql) => reconcileOrgPlan(sql, autumn, id)).pipe(
					Effect.provide(testPgLayer())
				)
			),
		plan: async () =>
			(
				await control.query<{ plan: string }>(
					'SELECT plan FROM orgs WHERE id = $1',
					[orgId]
				)
			).rows[0]?.plan,
		close: async () => {
			await control.query('DELETE FROM orgs WHERE id = $1', [orgId]);
			await control.end();
		}
	};
};

describe('authoritative billing webhook reconciliation', () => {
	it('retains the local plan on provider failure and skips unknown customers', async () => {
		const getPlan = vi.fn(() =>
			Effect.fail(
				new StorageError({
					operation: 'read Autumn subscriptions',
					cause: 'provider unavailable'
				})
			)
		);
		const fixture = await setup(getPlan);
		try {
			await expect(fixture.run()).rejects.toMatchObject({
				_tag: 'StorageError'
			});
			expect(await fixture.plan()).toBe('pro');
			expect(await fixture.run(`unknown-${crypto.randomUUID()}`)).toBeNull();
			expect(getPlan).toHaveBeenCalledOnce();
		} finally {
			await fixture.close();
		}
	});

	it('locks before reading the provider, so overlapping events apply the latest state last', async () => {
		const reading = Promise.withResolvers<void>();
		const resume = Promise.withResolvers<void>();
		let reads = 0;
		const fixture = await setup(() =>
			Effect.gen(function* () {
				reads += 1;
				if (reads === 1) {
					reading.resolve();
					yield* Effect.promise(() => resume.promise);
					return 'pro' as const;
				}
				return 'free' as const;
			})
		);
		const first = fixture.run();
		let second: ReturnType<typeof fixture.run> | undefined;
		try {
			await Promise.race([
				reading.promise,
				first.then(() => {
					throw new Error('Provider was not read');
				})
			]);
			second = fixture.run();
			await vi.waitFor(async () => {
				const result = await fixture.control.query<{ count: string }>(`
					SELECT count(*) FROM pg_stat_activity
					WHERE datname = current_database() AND wait_event_type = 'Lock'
					AND query LIKE '%SELECT id FROM orgs%'`);
				expect(Number(result.rows[0]?.count)).toBeGreaterThan(0);
			});
			expect(reads).toBe(1);
			resume.resolve();
			expect(await first).toBe('pro');
			expect(await second).toBe('free');
			expect(await fixture.plan()).toBe('free');
			expect(reads).toBe(2);
		} finally {
			resume.resolve();
			await Promise.allSettled([first, ...(second ? [second] : [])]);
			await fixture.close();
		}
	});
});
