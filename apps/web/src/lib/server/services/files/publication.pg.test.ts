import { Effect } from 'effect';
import { Client } from 'pg';
import { describe, expect, it, vi } from 'vitest';
import { runWorkerProgram, type AppServices } from '../../edge';
import { PgSql } from '../../pg';
import { ensureTenant } from '../../tenants';
import { TEST_DATABASE_URL } from '../../test/database';
import { testTenant } from '../../test/org';
import { createRouteContext } from '../../test/route-context';
import { Files } from '../files';
import type { MutationResult } from './types';

const body = () => new Response('x').body;

const setup = async () => {
	const ctx = await createRouteContext();
	const suffix = crypto.randomUUID().replaceAll('-', '').slice(0, 16);
	const tenant = testTenant(`org_publish_${suffix}`, `user_publish_${suffix}`);
	await runWorkerProgram(
		ctx.env,
		Effect.flatMap(PgSql, (sql) => ensureTenant(sql, tenant))
	);
	const control = new Client({ connectionString: TEST_DATABASE_URL });
	await control.connect();
	await control.query("UPDATE orgs SET trust = 'verified' WHERE id = $1", [
		tenant.orgId
	]);
	const run = <A, E>(program: Effect.Effect<A, E, AppServices>) =>
		runWorkerProgram(ctx.env, program, {
			orgId: tenant.orgId,
			userId: tenant.userId
		});
	const upload = (name = 'publication.txt', isPublic = true) =>
		run(
			Effect.flatMap(Files, (files) =>
				files.upload({
					displayName: name,
					contentType: name.endsWith('.html') ? 'text/html' : 'text/plain',
					public: isPublic,
					contentLength: '1',
					body: body(),
					tags: [],
					expiresAt: null
				})
			)
		);
	const state = async (id: string) =>
		(
			await control.query<{
				public: boolean;
				publish_pending: boolean;
				current_version: number;
				scan_pending: boolean;
			}>(
				`SELECT f.public, f.publish_pending, f.current_version,
					v.scan_next_run_at IS NOT NULL AS scan_pending
				 FROM files f JOIN file_versions v
					ON v.file_id = f.id AND v.version = f.current_version
				 WHERE f.id = $1`,
				[id]
			)
		).rows[0];
	const scanVersions = (id: string) =>
		ctx.jobs.flatMap(({ body }) =>
			body.kind === 'scan' && body.fileId === id ? [body.version] : []
		);
	const cleanup = async () => {
		try {
			await control.query('ROLLBACK');
			const keys = await control.query<{ r2_key: string }>(
				'SELECT r2_key FROM file_versions WHERE org_id = $1',
				[tenant.orgId]
			);
			if (keys.rows.length > 0) {
				await ctx.env.BUCKET.delete(keys.rows.map((row) => row.r2_key));
			}
			await control.query('DELETE FROM files WHERE org_id = $1', [
				tenant.orgId
			]);
			await control.query('DELETE FROM orgs WHERE id = $1', [tenant.orgId]);
			await control.query('DELETE FROM users WHERE id = $1', [tenant.userId]);
		} finally {
			await control.end();
		}
	};
	return { control, tenant, run, upload, state, scanVersions, cleanup };
};

describe('file publication waits for its own scan', () => {
	it.each([
		{ name: 'fresh.txt', requestedPublic: true },
		{ name: 'fresh.html', requestedPublic: false }
	])(
		'holds an initial $name upload with durable scan intent',
		async (input) => {
			const { run, upload, state, scanVersions, cleanup } = await setup();
			try {
				const uploaded = await upload(input.name, input.requestedPublic);
				expect(uploaded.file.public).toBe(false);
				expect(await state(uploaded.file.id)).toEqual({
					public: false,
					publish_pending: true,
					current_version: 1,
					scan_pending: true
				});
				expect(scanVersions(uploaded.file.id)).toEqual([1]);
				const content = await run(
					Effect.flatMap(Files, (files) => files.findContent(uploaded.file.id))
				);
				expect(content.file.public).toBe(false);
			} finally {
				await cleanup();
			}
		}
	);

	it('preserves publication intent across pending, public, and restored versions', async () => {
		const { control, tenant, run, upload, state, scanVersions, cleanup } =
			await setup();
		try {
			const first = await upload();
			const id = first.file.id;
			const replace = () =>
				run(
					Effect.flatMap(Files, (files) =>
						files.uploadVersion({
							id,
							contentType: 'text/plain',
							contentLength: '1',
							body: body()
						})
					)
				);
			for (const expectedVersion of [2, 3, 4]) {
				if (expectedVersion === 3) {
					// The previous version's scan has published it. New bytes
					// must get their own hold even though the file was public.
					await control.query(
						'UPDATE files SET public = true, publish_pending = false WHERE id = $1',
						[id]
					);
				}
				const changed =
					expectedVersion === 4
						? await run(
								Effect.flatMap(Files, (files) => files.restoreVersion(id, 1))
							)
						: await replace();
				expect(changed.file).toMatchObject({
					version: expectedVersion,
					public: false,
					publishPending: true
				});
				expect(await state(id)).toEqual({
					public: false,
					publish_pending: true,
					current_version: expectedVersion,
					scan_pending: true
				});
			}
			expect(scanVersions(id)).toEqual([1, 2, 3, 4]);

			await control.query(
				"UPDATE orgs SET trust = 'established' WHERE id = $1",
				[tenant.orgId]
			);
			expect((await replace()).file).toMatchObject({
				version: 5,
				public: true,
				publishPending: false
			});
			expect(await state(id)).toEqual({
				public: true,
				publish_pending: false,
				current_version: 5,
				scan_pending: true
			});
			expect(scanVersions(id)).toEqual([1, 2, 3, 4, 5]);
		} finally {
			await cleanup();
		}
	});

	it.each(['rename', 'visibility'] as const)(
		'%s rechecks a concurrent replacement before applying publication state',
		async (action) => {
			const { control, tenant, run, upload, state, scanVersions, cleanup } =
				await setup();
			let mutation: Promise<MutationResult> | undefined;
			try {
				const uploaded = await upload();
				const id = uploaded.file.id;
				await control.query(
					'UPDATE files SET public = true, publish_pending = false WHERE id = $1',
					[id]
				);
				await control.query('BEGIN');
				// The publisher owns the file lock while promoting a new held
				// version. A nonlocking read would still see public version 1.
				await control.query(
					`UPDATE files SET current_version = 2, public = false,
						publish_pending = true WHERE id = $1`,
					[id]
				);
				await control.query(
					`INSERT INTO file_versions
						(file_id, org_id, version, r2_key, size_bytes, content_type, created_at)
					 VALUES ($1, $2, 2, $3, 1, 'text/plain', now())`,
					[id, tenant.orgId, `publication-race/${id}/2`]
				);
				mutation = run(
					Effect.flatMap(Files, (files) =>
						action === 'rename'
							? files.rename(id, 'renamed.txt')
							: files.setVisibility(id, true)
					)
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
				await control.query('COMMIT');
				expect((await mutation).file).toMatchObject({
					version: 2,
					public: false,
					publishPending: true
				});
				expect(await state(id)).toEqual({
					public: false,
					publish_pending: true,
					current_version: 2,
					scan_pending: true
				});
				expect(scanVersions(id)).toEqual([1, 2]);
			} finally {
				await control.query('ROLLBACK');
				await mutation?.catch(() => {});
				await cleanup();
			}
		}
	);
});
