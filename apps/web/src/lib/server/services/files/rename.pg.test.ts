import { Effect } from 'effect';
import { Client } from 'pg';
import { describe, expect, it, vi } from 'vitest';
import { runWorkerProgram } from '../../edge';
import { PgSql } from '../../pg';
import { ensureTenant } from '../../tenants';
import { TEST_DATABASE_URL } from '../../test/database';
import { testTenant } from '../../test/org';
import { createRouteContext } from '../../test/route-context';
import { Files } from '../files';

describe('rename indexing delivery after a concurrent write', () => {
	it.each(['version', 'deletion'] as const)(
		'uses the row updated by rename after a concurrent %s change',
		async (change) => {
			const ctx = await createRouteContext();
			const suffix = crypto.randomUUID().replaceAll('-', '').slice(0, 16);
			const tenant = testTenant(
				`org_rename_${suffix}`,
				`user_rename_${suffix}`
			);
			const fileId = crypto.randomUUID();
			await runWorkerProgram(
				ctx.env,
				Effect.flatMap(PgSql, (sql) => ensureTenant(sql, tenant))
			);
			const control = new Client({ connectionString: TEST_DATABASE_URL });
			await control.connect();
			const rename = () =>
				runWorkerProgram(
					ctx.env,
					Effect.flatMap(Files, (files) =>
						Effect.result(files.rename(fileId, 'renamed.txt'))
					),
					{ orgId: tenant.orgId, userId: tenant.userId }
				);
			let renaming: ReturnType<typeof rename> | undefined;
			try {
				await control.query(
					`INSERT INTO files
						(id, org_id, display_name, content_type, size_bytes, created_at, updated_at)
					 VALUES ($1, $2, 'original.txt', 'text/plain', 1, now(), now())`,
					[fileId, tenant.orgId]
				);
				await control.query(
					`INSERT INTO file_versions
						(file_id, org_id, version, r2_key, size_bytes, content_type, created_at, text_content)
					 VALUES ($1, $2, 1, $3, 1, 'text/plain', now(), 'old text')`,
					[fileId, tenant.orgId, `rename-test/${fileId}/1`]
				);
				await control.query('BEGIN');
				if (change === 'version') {
					// The concurrent publisher owns the file row while promoting an
					// already-indexed version. Rename must reread after that commit.
					await control.query(
						`UPDATE files SET current_version = 2, index_state = 'ready', indexed_version = 2
						 WHERE id = $1`,
						[fileId]
					);
					await control.query(
						`INSERT INTO file_versions
							(file_id, org_id, version, r2_key, size_bytes, content_type, created_at, text_content)
						 VALUES ($1, $2, 2, $3, 1, 'text/plain', now(), 'new text')`,
						[fileId, tenant.orgId, `rename-test/${fileId}/2`]
					);
				} else {
					await control.query('DELETE FROM files WHERE id = $1', [fileId]);
				}
				renaming = rename();
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
				await control.query('COMMIT');
				const result = await renaming;
				if (change === 'version') {
					expect(result).toMatchObject({
						_tag: 'Success',
						success: { file: { version: 2, displayName: 'renamed.txt' } }
					});
					expect(ctx.jobs.map((job) => job.body)).toEqual([
						{ kind: 'index', orgId: tenant.orgId, fileId, version: 2 }
					]);
					expect(
						(
							await control.query(
								'SELECT display_name, current_version, index_state FROM files WHERE id = $1',
								[fileId]
							)
						).rows
					).toEqual([
						{
							display_name: 'renamed.txt',
							current_version: 2,
							index_state: 'pending'
						}
					]);
				} else {
					expect(result).toMatchObject({
						_tag: 'Failure',
						failure: { _tag: 'NotFound', id: fileId }
					});
					expect(ctx.jobs).toEqual([]);
				}
			} finally {
				await control.query('ROLLBACK');
				await renaming?.catch(() => {});
				try {
					await control.query('DELETE FROM files WHERE org_id = $1', [
						tenant.orgId
					]);
					await control.query('DELETE FROM orgs WHERE id = $1', [tenant.orgId]);
					await control.query('DELETE FROM users WHERE id = $1', [
						tenant.userId
					]);
				} finally {
					await control.end();
				}
			}
		}
	);
});
