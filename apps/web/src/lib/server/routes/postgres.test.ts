import { describe, expect, it } from 'vitest';
import { Effect } from 'effect';
import { createRouteContext } from '../test/route-context';

// Proves the Hyperdrive binding, the pg driver on workerd, and the
// migrations all line up: the request layer can open a transaction
// against the migrated test database.
describe('postgres through the request layer', () => {
	it('runs a transaction against the migrated schema', async () => {
		const ctx = await createRouteContext();
		const { runWorkerProgram } = await import('$lib/server/edge');
		const { PgSql } = await import('$lib/server/pg');
		const result = await runWorkerProgram(
			ctx.env,
			Effect.gen(function* () {
				const sql = yield* PgSql;
				const rows = yield* sql.withTransaction(
					sql<{ tables: number; vector: boolean; trgm: boolean }>`
						SELECT
							(SELECT count(*) FROM information_schema.tables
								WHERE table_schema = 'public') AS tables,
							EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'vector') AS vector,
							EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_trgm') AS trgm`
				);
				return rows[0];
			})
		);
		expect(result?.vector).toBe(true);
		expect(result?.trgm).toBe(true);
		expect(result?.tables).toBeGreaterThan(10);
	});
});
