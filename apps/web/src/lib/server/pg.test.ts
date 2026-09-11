import { Cause, Effect, Exit } from 'effect';
import Pg from 'pg';
import { afterEach, describe, expect, it } from 'vitest';
import { PgSql, pgLayer } from './pg';

const OriginalPool = Pg.Pool;
afterEach(() => {
	Pg.Pool = OriginalPool;
});

describe('request Postgres pool', () => {
	it.each(['success', 'failure', 'interruption'] as const)(
		'handles idle errors and closes after %s',
		async (outcome) => {
			let pool: Pg.Pool | undefined;
			Pg.Pool = class extends OriginalPool {
				constructor(options?: Pg.PoolConfig) {
					super(options);
					pool = this;
				}
			};

			const result = await Effect.runPromiseExit(
				Effect.gen(function* () {
					yield* PgSql;
					if (!pool) throw new Error('Pool was not acquired');
					pool.emit('error', new Error('Idle connection disconnected'));
					if (outcome === 'failure') return yield* Effect.fail('query failed');
					if (outcome === 'interruption') return yield* Effect.interrupt;
				}).pipe(
					Effect.provide(
						pgLayer({
							connectionString: 'postgres://unused:unused@127.0.0.1:1/unused'
						})
					)
				)
			);

			expect(
				Exit.isSuccess(result),
				Exit.isFailure(result) ? Cause.pretty(result.cause) : undefined
			).toBe(outcome === 'success');
			if (Exit.isFailure(result)) {
				expect(Cause.hasDies(result.cause)).toBe(false);
				expect(Cause.hasFails(result.cause)).toBe(outcome === 'failure');
				expect(Cause.hasInterruptsOnly(result.cause)).toBe(
					outcome === 'interruption'
				);
			}
			expect(pool?.ended).toBe(true);
		}
	);
});
