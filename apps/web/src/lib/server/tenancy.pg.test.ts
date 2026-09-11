import { Effect } from 'effect';
import { describe, expect, it } from 'vitest';
import { PgSql } from './pg';
import { CurrentOrg } from './services/current-org';
import { ensureTenant } from './tenants';
import { testTenant } from './test/org';
import { testPgLayer } from './test/pg';

const NOW = '2026-09-09T00:00:00.000Z';

const run = <A, E>(
	effect: Effect.Effect<A, E, PgSql | CurrentOrg>,
	orgId: string
) =>
	Effect.runPromise(
		effect.pipe(
			Effect.provideService(CurrentOrg, { id: orgId }),
			Effect.provide(testPgLayer())
		)
	);

// The docker role is a superuser and bypasses RLS, so the policies are
// exercised by switching to the application role inside the transaction.
describe('row level security on tenant tables', () => {
	it('hides other orgs inside a pinned transaction and stays inert outside one', async () => {
		const suffix = crypto.randomUUID();
		const orgA = `org_rls_a_${suffix}`;
		const orgB = `org_rls_b_${suffix}`;
		const fileA = `rls-a-${suffix}`;
		const fileB = `rls-b-${suffix}`;
		const result = await run(
			Effect.gen(function* () {
				const sql = yield* PgSql;
				yield* ensureTenant(sql, testTenant(orgA, `user_rls_a_${suffix}`));
				yield* ensureTenant(sql, testTenant(orgB, `user_rls_b_${suffix}`));
				yield* sql`INSERT INTO files (id, org_id, display_name, content_type, size_bytes, created_at, updated_at)
					VALUES (${fileA}, ${orgA}, 'a.txt', 'text/plain', 1, ${NOW}, ${NOW}),
						(${fileB}, ${orgB}, 'b.txt', 'text/plain', 1, ${NOW}, ${NOW})`;
				const ids = (rows: ReadonlyArray<{ id: string }>) =>
					rows.map((row) => row.id).sort();
				// The wrapped withTransaction pins CurrentOrg (orgA) after BEGIN.
				const pinned = yield* sql.withTransaction(
					Effect.gen(function* () {
						yield* sql`SET LOCAL ROLE adrive_app`;
						const visible = yield* sql<{ id: string }>`
							SELECT id FROM files WHERE id IN (${fileA}, ${fileB})`;
						const crossOrgUpdate = yield* sql<{ id: string }>`
							UPDATE files SET display_name = 'x' WHERE id = ${fileB} RETURNING id`;
						return {
							visible: ids(visible),
							crossOrgUpdate: ids(crossOrgUpdate)
						};
					})
				);
				const unpinned = yield* sql`SET ROLE adrive_app`.pipe(
					Effect.andThen(
						sql<{
							id: string;
						}>`SELECT id FROM files WHERE id IN (${fileA}, ${fileB})`
					),
					Effect.map(ids),
					Effect.ensuring(Effect.ignore(sql`RESET ROLE`))
				);
				return { pinned, unpinned };
			}),
			orgA
		);
		expect(result.pinned).toEqual({ visible: [fileA], crossOrgUpdate: [] });
		expect(result.unpinned).toEqual([fileA, fileB].sort());
	});
});
