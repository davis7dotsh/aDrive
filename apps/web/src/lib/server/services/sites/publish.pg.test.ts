import { Effect } from 'effect';
import { Client } from 'pg';
import { describe, expect, it, vi } from 'vitest';
import { AppConfig } from '../../config';
import { runWorkerProgram } from '../../edge';
import { PgSql } from '../../pg';
import { TEST_DATABASE_URL } from '../../test/database';
import { createRouteContext } from '../../test/route-context';
import { Blobs } from '../blobs';
import { JobQueue } from '../jobs';
import { ensureTestOrg, TEST_ORG_ID, TEST_USER_ID } from '../../test/org';
import { createInternals } from './internals';
import { sessionOps } from './sessions';

describe('site publication competing with purge', () => {
	it.each([true, false])(
		'rechecks a blocked purge claim that commits=%s',
		async (commits) => {
			const ctx = await createRouteContext();
			await runWorkerProgram(ctx.env, Effect.flatMap(PgSql, ensureTestOrg));
			const control = new Client({ connectionString: TEST_DATABASE_URL });
			await control.connect();
			await control.query(
				"UPDATE orgs SET trust = 'established' WHERE id = $1",
				[TEST_ORG_ID]
			);
			const fileId = crypto.randomUUID();
			const sessionId = crypto.randomUUID();
			const oldKey = `site/${fileId}/old.html`;
			const newKey = `site/${fileId}/new.html`;
			const deleted: string[] = [];
			let publish: Promise<boolean> | undefined;
			try {
				await control.query(
					`INSERT INTO files (org_id, id, display_name, content_type, is_site, current_version,
				 size_bytes, created_at, updated_at)
				 VALUES ('${TEST_ORG_ID}', $1, 'site', 'text/html', true, 1, 1, now(), now())`,
					[fileId]
				);
				await control.query(
					`INSERT INTO file_versions (org_id, file_id, version, r2_key, size_bytes, content_type, created_at)
				 VALUES ('${TEST_ORG_ID}', $1, 1, $2, 1, 'text/html', now())`,
					[fileId, `site-version/${fileId}/1`]
				);
				await control.query(
					`INSERT INTO site_assets (file_id, version, path, r2_key, content_type, size_bytes)
				 VALUES ($1, 1, 'index.html', $2, 'text/html', 1)`,
					[fileId, oldKey]
				);
				await control.query(
					`INSERT INTO site_upload_sessions
				 (org_id, id, file_id, display_name, version, status, created_at, expires_at)
				 VALUES ('${TEST_ORG_ID}', $1, $2, 'site', 2, 'open', now(), now() + interval '1 hour')`,
					[sessionId, fileId]
				);
				await control.query(
					`INSERT INTO staged_site_assets (session_id, path, expected_size_bytes, content_type,
				 r2_key, stored_size_bytes, uploaded_at)
				 VALUES ($1, 'index.html', 1, 'text/html', $2, 1, now())`,
					[sessionId, newKey]
				);
				await control.query('BEGIN');
				await control.query(
					"UPDATE files SET purge_state = 'pending', deleted_at = now() WHERE id = $1",
					[fileId]
				);
				publish = runWorkerProgram(
					ctx.env,
					Effect.gen(function* () {
						const sql = yield* PgSql;
						const config = yield* AppConfig;
						const blobs = yield* Blobs;
						const internals = createInternals({
							org: { id: TEST_ORG_ID, slug: TEST_ORG_ID.replaceAll('_', '-') },
							sql,
							config,
							jobs: JobQueue.of({
								send: () => Effect.void,
								trySend: () => Effect.void
							}),
							blobs: {
								...blobs,
								deleteMany: (keys) =>
									Effect.sync(() => {
										deleted.push(...keys);
									})
							}
						});
						return yield* sessionOps(internals)
							.commit(sessionId)
							.pipe(
								Effect.as(true),
								Effect.catchTag('StorageError', () => Effect.succeed(false))
							);
					}),
					{ orgId: TEST_ORG_ID, userId: TEST_USER_ID }
				);
				await vi.waitFor(
					async () => {
						await control.query('SELECT pg_stat_clear_snapshot()');
						const waiting = await control.query<{ count: number }>(
							`SELECT count(*)::int AS count FROM pg_stat_activity
					 WHERE pg_backend_pid() = ANY(pg_blocking_pids(pid))`
						);
						expect(waiting.rows[0]?.count).toBeGreaterThan(0);
					},
					{ timeout: 5_000, interval: 10 }
				);
				await control.query(commits ? 'COMMIT' : 'ROLLBACK');
				expect(await publish).toBe(!commits);
				const file = await control.query<{ current_version: number }>(
					'SELECT current_version FROM files WHERE id = $1',
					[fileId]
				);
				expect(file.rows[0]?.current_version).toBe(commits ? 1 : 2);
				const assets = await control.query<{ r2_key: string }>(
					'SELECT r2_key FROM site_assets WHERE file_id = $1',
					[fileId]
				);
				expect(assets.rows.map((row) => row.r2_key)).toEqual([
					commits ? oldKey : newKey
				]);
				expect(deleted).toEqual([commits ? newKey : oldKey]);
			} finally {
				await control.query('ROLLBACK');
				await publish?.catch(() => {});
				await control.query('DELETE FROM site_upload_sessions WHERE id = $1', [
					sessionId
				]);
				await control.query('DELETE FROM files WHERE id = $1', [fileId]);
				await control.query(
					'DELETE FROM pending_site_asset_deletes WHERE file_id = $1',
					[fileId]
				);
				await control.end();
			}
		}
	);
});
