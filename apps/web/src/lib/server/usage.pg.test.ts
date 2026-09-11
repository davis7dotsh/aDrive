import { Effect, Exit } from 'effect';
import { describe, expect, it } from 'vitest';
import { semanticCommit, type IndexLease } from './indexing-sql';
import { PgSql } from './pg';
import { newIndexLeaseToken } from './semantic-policy';
import { ensureTenant } from './tenants';
import { testTenant } from './test/org';
import { testPgLayer } from './test/pg';
import {
	commitAiOps,
	readOrgUsage,
	recordAiOps,
	releaseAiOps,
	reserveAiOps
} from './usage';

const run = <A, E>(effect: Effect.Effect<A, E, PgSql>) =>
	Effect.runPromise(effect.pipe(Effect.provide(testPgLayer())));
const future = () => new Date(Date.now() + 5 * 60_000).toISOString();
const tenant = () => `org_ai_quota_${crypto.randomUUID()}`;

describe('local AI quota reservations', () => {
	it('admits only one concurrent reservation when their combined work exceeds the plan', async () => {
		const orgId = tenant();
		const tokens = [newIndexLeaseToken(), newIndexLeaseToken()];
		const result = await run(
			Effect.gen(function* () {
				const sql = yield* PgSql;
				yield* ensureTenant(sql, testTenant(orgId, `user_${orgId}`));
				const allowed = yield* Effect.all(
					tokens.map((token) => reserveAiOps(sql, orgId, token, 300, future())),
					{ concurrency: 'unbounded' }
				);
				const winner = tokens[allowed.findIndex(Boolean)];
				if (!winner) throw new Error('Expected one reservation');
				yield* sql.withTransaction(commitAiOps(sql, orgId, winner));
				const remaining = newIndexLeaseToken();
				const fits = yield* reserveAiOps(sql, orgId, remaining, 200, future());
				const over = yield* reserveAiOps(
					sql,
					orgId,
					newIndexLeaseToken(),
					1,
					future()
				);
				yield* releaseAiOps(sql, orgId, remaining);
				const released = yield* reserveAiOps(
					sql,
					orgId,
					newIndexLeaseToken(),
					200,
					future()
				);
				return {
					allowed,
					fits,
					over,
					released,
					usage: yield* readOrgUsage(sql, orgId)
				};
			})
		);
		expect(result.allowed.filter(Boolean)).toHaveLength(1);
		expect(result.fits).toBe(true);
		expect(result.over).toBe(false);
		expect(result.released).toBe(true);
		expect(result.usage?.aiOpsMonth).toBe(300);
	});

	it('reclaims expired reservations and ignores usage from the previous month', async () => {
		const orgId = tenant();
		const expired = newIndexLeaseToken();
		await run(
			Effect.gen(function* () {
				const sql = yield* PgSql;
				yield* ensureTenant(sql, testTenant(orgId, `user_${orgId}`));
				expect(yield* reserveAiOps(sql, orgId, expired, 500, future())).toBe(
					true
				);
				yield* sql`UPDATE ai_usage_reservations SET expires_at = now() - interval '1 second'
				WHERE org_id = ${orgId} AND token = ${expired}`;
				yield* recordAiOps(sql, orgId, 500);
				yield* sql`UPDATE org_usage SET ai_ops_month_reset_at = now() - interval '1 day' WHERE org_id = ${orgId}`;
				const fresh = newIndexLeaseToken();
				expect(yield* reserveAiOps(sql, orgId, fresh, 500, future())).toBe(
					true
				);
				yield* sql.withTransaction(commitAiOps(sql, orgId, fresh));
				expect((yield* readOrgUsage(sql, orgId))?.aiOpsMonth).toBe(500);
				expect(
					yield* reserveAiOps(sql, orgId, newIndexLeaseToken(), 1, future())
				).toBe(false);
			})
		);
	});

	it.each([false, true])(
		'commits the index and meter together (expired reservation: %s)',
		async (expired) => {
			const orgId = tenant();
			const fileId = `ai_meter_${crypto.randomUUID()}`;
			const lease = {
				orgId,
				fileId,
				version: 1,
				attempt: 1,
				token: newIndexLeaseToken()
			} satisfies IndexLease;
			const result = await run(
				Effect.gen(function* () {
					const sql = yield* PgSql;
					yield* ensureTenant(sql, testTenant(orgId, `user_${orgId}`));
					yield* sql`INSERT INTO files (id, org_id, display_name, content_type, size_bytes,
				created_at, updated_at, current_version, index_state, index_attempts, index_lease_token)
				VALUES (${fileId}, ${orgId}, 'meter.txt', 'text/plain', 4,
					now(), now(), 1, 'running', 1, ${lease.token})`;
					yield* sql`INSERT INTO file_versions (file_id, org_id, version, r2_key, size_bytes, content_type, created_at)
				VALUES (${fileId}, ${orgId}, 1, ${`v/${fileId}/1`}, 4, 'text/plain', now())`;
					expect(
						yield* reserveAiOps(sql, orgId, lease.token, 1, future())
					).toBe(true);
					if (expired)
						yield* sql`UPDATE ai_usage_reservations SET expires_at = now() - interval '1 second'
				WHERE org_id = ${orgId} AND token = ${lease.token}`;
					const committed = yield* Effect.exit(
						sql.withTransaction(
							Effect.gen(function* () {
								const stored = yield* semanticCommit(sql, lease, [
									{
										fileId,
										version: 1,
										ordinal: 0,
										charStart: 0,
										charEnd: 4,
										values: Array.from({ length: 384 }, (_, i) =>
											i === 0 ? 1 : 0
										)
									}
								]);
								expect(stored).toBe(true);
								yield* commitAiOps(sql, orgId, lease.token);
							})
						)
					);
					const rows = yield* sql<{ index_state: string; chunks: number }>`
				SELECT index_state, (SELECT count(*)::integer FROM file_chunks WHERE file_id = ${fileId}) AS chunks
				FROM files WHERE id = ${fileId} AND org_id = ${orgId}`;
					return {
						failed: Exit.isFailure(committed),
						state: rows[0],
						usage: yield* readOrgUsage(sql, orgId)
					};
				})
			);
			expect(result.failed).toBe(expired);
			expect(result.state).toEqual({
				index_state: expired ? 'running' : 'ready',
				chunks: expired ? 0 : 1
			});
			expect(result.usage?.aiOpsMonth).toBe(expired ? 0 : 1);
		}
	);

	it('fails when the durable usage row is missing', async () => {
		const orgId = tenant();
		await run(
			Effect.gen(function* () {
				const sql = yield* PgSql;
				yield* ensureTenant(sql, testTenant(orgId, `user_${orgId}`));
				yield* sql`DELETE FROM org_usage WHERE org_id = ${orgId}`;
				expect(
					Exit.isFailure(
						yield* Effect.exit(
							reserveAiOps(sql, orgId, newIndexLeaseToken(), 1, future())
						)
					)
				).toBe(true);
				expect(
					Exit.isFailure(yield* Effect.exit(recordAiOps(sql, orgId, 1)))
				).toBe(true);
			})
		);
	});

	it('retries an expired indexing lease instead of reporting quota exhaustion', async () => {
		const orgId = tenant();
		await run(
			Effect.gen(function* () {
				const sql = yield* PgSql;
				yield* ensureTenant(sql, testTenant(orgId, `user_${orgId}`));
				const result = yield* Effect.exit(
					reserveAiOps(
						sql,
						orgId,
						newIndexLeaseToken(),
						1,
						new Date(Date.now() - 1_000).toISOString()
					)
				);
				expect(Exit.isFailure(result)).toBe(true);
				expect((yield* readOrgUsage(sql, orgId))?.aiOpsMonth).toBe(0);
			})
		);
	});
});
