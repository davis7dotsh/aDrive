import { Effect } from 'effect';
import { Client } from 'pg';
import { describe, expect, it } from 'vitest';
import { runWorkerProgram, type AppServices } from '../edge';
import { PgSql } from '../pg';
import { TEST_DATABASE_URL } from '../test/database';
import { createRouteContext } from '../test/route-context';
import { Admin } from './admin';

// Use the restricted application role on every connection, not the local
// superuser that would hide tenant-policy mistakes in operator transactions.
describe('cross-organization operator moderation', () => {
	it('reviews the displayed version under RLS without leaking the operator override', async () => {
		const ctx = await createRouteContext();
		const control = new Client({ connectionString: TEST_DATABASE_URL });
		await control.connect();
		const suffix = crypto.randomUUID();
		const operator = `operator-${suffix}`;
		const target = `target-${suffix}`;
		const fileId = `file-${suffix}`;
		const connection = new URL(TEST_DATABASE_URL);
		connection.searchParams.set('options', '-c role=adrive_app');
		const env: Env = {
			...ctx.env,
			HYPERDRIVE: { ...ctx.env.HYPERDRIVE, connectionString: connection.href }
		};
		const run = <A, E>(program: Effect.Effect<A, E, AppServices>) =>
			runWorkerProgram(env, program, {
				orgId: operator,
				orgSlug: operator,
				userId: 'operator-user'
			});
		try {
			await control.query(
				'INSERT INTO orgs (id, slug, name) VALUES ($1,$1,$1),($2,$2,$2)',
				[operator, target]
			);
			await control.query(
				`INSERT INTO files (id,org_id,display_name,content_type,size_bytes,
				public,publish_pending,created_at,updated_at)
				VALUES ($1,$2,'held.txt','text/plain',1,false,true,now(),now())`,
				[fileId, target]
			);
			await control.query(
				`INSERT INTO file_versions (file_id,org_id,version,r2_key,size_bytes,content_type,created_at)
				VALUES ($1,$2,1,$1,1,'text/plain',now())`,
				[fileId, target]
			);
			const result = await run(
				Effect.gen(function* () {
					const sql = yield* PgSql;
					const admin = yield* Admin;
					const role = yield* sql<{
						rolname: string;
						rolsuper: boolean;
						rolbypassrls: boolean;
					}>`
					SELECT rolname,rolsuper,rolbypassrls FROM pg_roles WHERE rolname=current_user`;
					const visible = () =>
						sql.withTransaction(sql`SELECT id FROM files WHERE id=${fileId}`);
					const before = yield* visible();
					yield* admin.markFile(fileId, 1, 'clean', 'operator-user');
					const after = yield* visible();
					return { role, before, after };
				})
			);
			expect(result.role).toEqual([
				{ rolname: 'adrive_app', rolsuper: false, rolbypassrls: false }
			]);
			expect(result.before).toEqual([]);
			expect(result.after).toEqual([]);
			expect(
				(
					await control.query(
						'SELECT public,publish_pending FROM files WHERE id=$1',
						[fileId]
					)
				).rows
			).toEqual([{ public: true, publish_pending: false }]);

			await control.query(
				`INSERT INTO file_versions (file_id,org_id,version,r2_key,size_bytes,content_type,created_at)
				VALUES ($1,$2,2,$1 || '-2',1,'text/plain',now())`,
				[fileId, target]
			);
			await control.query(
				'UPDATE files SET current_version=2,public=false,publish_pending=true WHERE id=$1',
				[fileId]
			);
			const stale = await run(
				Effect.flatMap(Admin, (admin) =>
					Effect.result(admin.markFile(fileId, 1, 'clean', 'operator-user'))
				)
			);
			expect(stale).toMatchObject({
				_tag: 'Failure',
				failure: { _tag: 'InvalidRequest', status: 409 }
			});
			expect(
				(
					await control.query(
						'SELECT public,publish_pending FROM files WHERE id=$1',
						[fileId]
					)
				).rows
			).toEqual([{ public: false, publish_pending: true }]);
			expect(
				(
					await control.query(
						"SELECT version FROM scan_verdicts WHERE file_id=$1 AND source='admin' ORDER BY version",
						[fileId]
					)
				).rows
			).toEqual([{ version: 1 }]);
			await run(
				Effect.flatMap(Admin, (admin) =>
					admin.markFile(fileId, 2, 'clean', 'operator-user')
				)
			);
			expect(
				(
					await control.query(
						'SELECT public,publish_pending FROM files WHERE id=$1',
						[fileId]
					)
				).rows
			).toEqual([{ public: true, publish_pending: false }]);
		} finally {
			await control.query('DELETE FROM files WHERE id=$1', [fileId]);
			await control.query('DELETE FROM orgs WHERE id IN ($1,$2)', [
				operator,
				target
			]);
			await control.end();
		}
	});
});
