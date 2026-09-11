import { Effect } from 'effect';
import { Client } from 'pg';
import { describe, expect, it, vi } from 'vitest';
import { AppConfig } from '../../config';
import { runWorkerProgram } from '../../edge';
import { PgSql } from '../../pg';
import { ensureTenant } from '../../tenants';
import { TEST_DATABASE_URL } from '../../test/database';
import { testTenant } from '../../test/org';
import { createRouteContext } from '../../test/route-context';
import { Blobs } from '../blobs';
import { CurrentOrg } from '../current-org';
import { JobQueue } from '../jobs';
import { Tags } from '../tags';
import { createInternals } from './internals';
import { mutationOps } from './mutations';

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
			const resume = Promise.withResolvers<void>();
			let snapshotVersion: number | undefined;
			const rename = () =>
				runWorkerProgram(
					ctx.env,
					Effect.gen(function* () {
						const sql = yield* PgSql;
						const config = yield* AppConfig;
						const blobs = yield* Blobs;
						const tags = yield* Tags;
						const org = yield* CurrentOrg;
						const jobs = yield* JobQueue;
						const internals = createInternals({
							sql,
							config,
							blobs,
							tags,
							org,
							jobs
						});
						const files = mutationOps({
							...internals,
							findDashboardFile: (id) =>
								internals.findDashboardFile(id).pipe(
									Effect.tap((file) =>
										Effect.promise(() => {
											snapshotVersion = file.version;
											return resume.promise;
										})
									)
								)
						});
						return yield* Effect.result(files.rename(fileId, 'renamed.txt'));
					}),
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
				renaming = rename();
				await vi.waitFor(() => expect(snapshotVersion).toBe(1), {
					timeout: 5_000,
					interval: 10
				});
				if (change === 'version') {
					// A version upload and its consumer finish while rename retains
					// the old dashboard snapshot. Its own delivery is already spent.
					await control.query('BEGIN');
					await control.query(
						`INSERT INTO file_versions
							(file_id, org_id, version, r2_key, size_bytes, content_type, created_at, text_content)
						 VALUES ($1, $2, 2, $3, 1, 'text/plain', now(), 'new text')`,
						[fileId, tenant.orgId, `rename-test/${fileId}/2`]
					);
					await control.query(
						`UPDATE files SET current_version = 2, index_state = 'ready', indexed_version = 2
						 WHERE id = $1`,
						[fileId]
					);
					await control.query('COMMIT');
				} else {
					await control.query('DELETE FROM files WHERE id = $1', [fileId]);
				}
				resume.resolve();
				const result = await renaming;
				if (change === 'version') {
					expect(result._tag).toBe('Success');
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
				resume.resolve();
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
