import { Effect } from 'effect';
import { Client } from 'pg';
import { describe, expect, it, vi } from 'vitest';
import { AppConfig } from '../../config';
import { runWorkerProgram } from '../../edge';
import { PgSql } from '../../pg';
import { TEST_DATABASE_URL } from '../../test/database';
import { createRouteContext } from '../../test/route-context';
import { Blobs } from '../blobs';
import { ensureTestOrg, TEST_ORG_ID, TEST_USER_ID } from '../../test/org';
import { createInternals } from './internals';

describe('site cleanup competing with publication', () => {
	it.each([true, false])(
		'rechecks the session after a blocked publisher commits=%s',
		async (commits) => {
			const ctx = await createRouteContext();
			await runWorkerProgram(ctx.env, Effect.flatMap(PgSql, ensureTestOrg));
			const publisher = new Client({ connectionString: TEST_DATABASE_URL });
			await publisher.connect();
			const session = {
				id: crypto.randomUUID(),
				fileId: crypto.randomUUID(),
				version: 1
			};
			const key = `site/${session.fileId}/index.html`;
			const deleted: string[] = [];
			let cleanup: Promise<void> | undefined;
			try {
				await publisher.query(
					`INSERT INTO site_upload_sessions
						(org_id, id, file_id, display_name, version, status, created_at, expires_at)
					 VALUES ('${TEST_ORG_ID}', $1, $2, 'site', 1, 'open', now(), now() + interval '1 hour')`,
					[session.id, session.fileId]
				);
				await publisher.query(
					`INSERT INTO staged_site_assets
						(session_id, path, expected_size_bytes, content_type,
						 r2_key, stored_size_bytes, uploaded_at)
					 VALUES ($1, 'index.html', 1, 'text/html', $2, 1, now())`,
					[session.id, key]
				);
				await publisher.query('BEGIN');
				// Publishing owns this row from its initial guard through the
				// asset promotion and the final complete/staging-delete writes.
				await publisher.query(
					"UPDATE site_upload_sessions SET status = 'committing' WHERE id = $1",
					[session.id]
				);
				cleanup = runWorkerProgram(
					ctx.env,
					Effect.gen(function* () {
						const sql = yield* PgSql;
						const config = yield* AppConfig;
						const blobs = yield* Blobs;
						const internals = createInternals({
							org: { id: TEST_ORG_ID, slug: TEST_ORG_ID.replaceAll('_', '-') },
							sql,
							config,
							blobs: {
								...blobs,
								deleteMany: (keys) =>
									Effect.sync(() => {
										deleted.push(...keys);
									})
							}
						});
						yield* internals.cleanupStaged(session, 'aborted');
					}),
					{ orgId: TEST_ORG_ID, userId: TEST_USER_ID }
				);
				await vi.waitFor(
					async () => {
						await publisher.query('SELECT pg_stat_clear_snapshot()');
						const waiting = await publisher.query<{ count: number }>(
							`SELECT count(*)::int AS count FROM pg_stat_activity
						 WHERE pg_backend_pid() = ANY(pg_blocking_pids(pid))`
						);
						expect(waiting.rows[0]?.count).toBeGreaterThan(0);
					},
					{ timeout: 5_000, interval: 10 }
				);
				if (commits) {
					await publisher.query(
						"UPDATE site_upload_sessions SET status = 'complete' WHERE id = $1",
						[session.id]
					);
					await publisher.query(
						'DELETE FROM staged_site_assets WHERE session_id = $1',
						[session.id]
					);
					await publisher.query('COMMIT');
				} else {
					await publisher.query('ROLLBACK');
				}
				await cleanup;
				expect(deleted).toEqual(commits ? [] : [key]);
				const state = await publisher.query<{ status: string }>(
					'SELECT status FROM site_upload_sessions WHERE id = $1',
					[session.id]
				);
				expect(state.rows[0]?.status).toBe(commits ? 'complete' : 'aborted');
			} finally {
				await publisher.query('ROLLBACK');
				await cleanup?.catch(() => {});
				await publisher.query(
					'DELETE FROM site_upload_sessions WHERE id = $1',
					[session.id]
				);
				await publisher.query(
					'DELETE FROM pending_site_asset_deletes WHERE file_id = $1',
					[session.fileId]
				);
				await publisher.end();
			}
		}
	);
});
