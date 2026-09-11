import { Effect } from 'effect';
import { Client } from 'pg';
import { describe, expect, it, vi } from 'vitest';
import { AppConfig } from '../../config';
import { runWorkerProgram } from '../../edge';
import { PgSql } from '../../pg';
import { TEST_DATABASE_URL } from '../../test/database';
import { createRouteContext } from '../../test/route-context';
import { Blobs } from '../blobs';
import { createInternals } from './internals';
import { sessionOps } from './sessions';

describe('site asset staging competing with abort', () => {
	it.each([true, false])(
		'rechecks a blocked abort that commits=%s',
		async (commits) => {
			const ctx = await createRouteContext();
			const control = new Client({ connectionString: TEST_DATABASE_URL });
			await control.connect();
			const sessionId = crypto.randomUUID();
			const fileId = crypto.randomUUID();
			const written: string[] = [];
			const deleted: string[] = [];
			const stored = new Set<string>();
			let staging: Promise<number> | undefined;
			try {
				await control.query(
					`INSERT INTO site_upload_sessions
					 (id, file_id, display_name, version, status, created_at, expires_at)
					 VALUES ($1, $2, 'site', 1, 'open', now(), now() + interval '1 hour')`,
					[sessionId, fileId]
				);
				await control.query(
					`INSERT INTO staged_site_assets
					 (session_id, path, expected_size_bytes, content_type)
					 VALUES ($1, 'index.html', 1, 'text/html')`,
					[sessionId]
				);
				await control.query('BEGIN');
				await control.query(
					"UPDATE site_upload_sessions SET status = 'aborted' WHERE id = $1",
					[sessionId]
				);
				staging = runWorkerProgram(
					ctx.env,
					Effect.gen(function* () {
						const sql = yield* PgSql;
						const config = yield* AppConfig;
						const blobs = yield* Blobs;
						const internals = createInternals({
							sql,
							config,
							blobs: {
								...blobs,
								put: (key, _body, size) =>
									Effect.sync(() => {
										written.push(key);
										stored.add(key);
										return { size, etag: 'staging-test-etag' };
									}),
								delete: (key) =>
									Effect.sync(() => {
										deleted.push(key);
										stored.delete(key);
									}),
								deleteMany: (keys) =>
									Effect.sync(() => {
										deleted.push(...keys);
										for (const key of keys) stored.delete(key);
									})
							}
						});
						return yield* sessionOps(internals)
							.stageAsset({
								sessionId,
								path: 'index.html',
								contentLength: '1',
								body: new Response('x').body
							})
							.pipe(
								Effect.as(201),
								Effect.catchTag('InvalidRequest', (failure) =>
									Effect.succeed(failure.status)
								)
							);
					})
				);
				// The uploader initially sees the committed open session. After
				// storing bytes it must wait for the abort before recording them.
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
				expect(written).toHaveLength(1);
				if (commits) {
					await control.query(
						'DELETE FROM staged_site_assets WHERE session_id = $1',
						[sessionId]
					);
					await control.query('COMMIT');
				} else {
					await control.query('ROLLBACK');
				}
				expect(await staging).toBe(commits ? 409 : 201);
				const { rows: assets } = await control.query(
					'SELECT r2_key, stored_size_bytes::int AS size FROM staged_site_assets WHERE session_id = $1',
					[sessionId]
				);
				expect(assets).toEqual(
					commits ? [] : [{ r2_key: written[0], size: 1 }]
				);
				expect(deleted).toEqual(commits ? written : []);
				expect([...stored]).toEqual(commits ? [] : written);
				const { rows: sessions } = await control.query(
					'SELECT status FROM site_upload_sessions WHERE id = $1',
					[sessionId]
				);
				expect(sessions).toEqual([{ status: commits ? 'aborted' : 'open' }]);
			} finally {
				await control.query('ROLLBACK');
				await staging?.catch(() => {});
				await control.query('DELETE FROM site_upload_sessions WHERE id = $1', [
					sessionId
				]);
				await control.query(
					'DELETE FROM pending_site_asset_deletes WHERE file_id = $1',
					[fileId]
				);
				await control.end();
			}
		}
	);
});
