import { Effect } from 'effect';
import { Client } from 'pg';
import { describe, expect, it, vi } from 'vitest';
import { AppConfig } from '../../config';
import { runWorkerProgram, type AppServices } from '../../edge';
import { InvalidRequest, StorageError } from '../../errors';
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
import { purgeOps } from './purge';

const fileOps = (
	changeBlobs: (blobs: Blobs['Service']) => Blobs['Service'] = (blobs) => blobs
) =>
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
			blobs: changeBlobs(blobs),
			tags,
			org,
			jobs
		});
		return { ...purgeOps(internals), ...mutationOps(internals) };
	});

const setup = async () => {
	const ctx = await createRouteContext();
	const suffix = crypto.randomUUID().replaceAll('-', '').slice(0, 16);
	const tenant = testTenant(`org_purge_${suffix}`, `user_purge_${suffix}`);
	const fileId = crypto.randomUUID();
	const key = `purge-test/${fileId}`;
	await runWorkerProgram(
		ctx.env,
		Effect.flatMap(PgSql, (sql) => ensureTenant(sql, tenant))
	);
	const control = new Client({ connectionString: TEST_DATABASE_URL });
	await control.connect();
	await control.query(
		`INSERT INTO files
			(id, org_id, display_name, content_type, kind, current_version,
			 size_bytes, created_at, updated_at, deleted_at, purge_at)
		 VALUES ($1, $2, 'purge.txt', 'text/plain', 'file', 1, 1, now(), now(),
			 now() - interval '1 hour', now() - interval '30 minutes')`,
		[fileId, tenant.orgId]
	);
	await control.query(
		`INSERT INTO file_versions
			(file_id, org_id, version, r2_key, size_bytes, content_type, created_at)
		 VALUES ($1, $2, 1, $3, 1, 'text/plain', now())`,
		[fileId, tenant.orgId, key]
	);
	// One byte belongs to this file, seventeen to unrelated retained data.
	await control.query(
		'UPDATE org_usage SET stored_bytes = 18 WHERE org_id = $1',
		[tenant.orgId]
	);
	const run = <A, E>(program: Effect.Effect<A, E, AppServices>) =>
		runWorkerProgram(ctx.env, program, {
			orgId: tenant.orgId,
			userId: tenant.userId
		});
	const cleanup = async () => {
		try {
			await control.query('ROLLBACK');
			await control.query('DELETE FROM files WHERE org_id = $1', [
				tenant.orgId
			]);
			await control.query('DELETE FROM orgs WHERE id = $1', [tenant.orgId]);
			await control.query('DELETE FROM users WHERE id = $1', [tenant.userId]);
			await ctx.env.BUCKET.delete(key);
		} finally {
			await control.end();
		}
	};
	return { ctx, control, tenant, fileId, key, run, cleanup };
};

describe('queue purge ownership and recovery', () => {
	it('skips a consumer claim without waiting or overwriting its fresh lease', async () => {
		const { control, fileId, run, cleanup } = await setup();
		const leaseUntil = new Date(Date.now() + 5 * 60_000).toISOString();
		let sweep: Promise<number> | undefined;
		let swept: number | undefined;
		try {
			await control.query('BEGIN');
			await control.query(
				`UPDATE files SET purge_state = 'pending', purge_attempts = 1,
					purge_next_run_at = $2 WHERE id = $1`,
				[fileId, leaseUntil]
			);
			// A separate connection still sees the old, eligible row. Its
			// candidate scan must skip the consumer's lock rather than wait
			// and replace the newly committed lease with the sweep timestamp.
			sweep = run(
				Effect.flatMap(fileOps(), (files) => files.sweepPurges(10))
			).then((count) => {
				swept = count;
				return count;
			});
			await vi.waitFor(() => expect(swept).toBe(0), {
				timeout: 5_000,
				interval: 10
			});
			await control.query('COMMIT');
			expect(await sweep).toBe(0);
			const row = await control.query<{
				purge_state: string;
				purge_next_run_at: Date;
			}>('SELECT purge_state, purge_next_run_at FROM files WHERE id = $1', [
				fileId
			]);
			expect(row.rows[0]?.purge_state).toBe('pending');
			expect(row.rows[0]?.purge_next_run_at.toISOString()).toBe(leaseUntil);
		} finally {
			await control.query('ROLLBACK');
			await sweep?.catch(() => {});
			await cleanup();
		}
	});

	it('refuses restoration after originals were deleted and retains quota until retry completes', async () => {
		const { ctx, control, tenant, fileId, key, run, cleanup } = await setup();
		let failThumbnails = true;
		const operations = () =>
			fileOps((blobs) => ({
				...blobs,
				deletePrefixes: (prefixes) =>
					failThumbnails
						? Effect.fail(
								new StorageError({
									operation: 'delete blob prefixes',
									cause: 'injected thumbnail cleanup failure'
								})
							)
						: blobs.deletePrefixes(prefixes)
			}));
		const usage = async () =>
			(
				await control.query<{ stored_bytes: string }>(
					'SELECT stored_bytes FROM org_usage WHERE org_id = $1',
					[tenant.orgId]
				)
			).rows[0]?.stored_bytes;
		try {
			await ctx.env.BUCKET.put(key, 'x');
			await run(
				Effect.flatMap(operations(), (files) => files.purgeOne(fileId))
			);
			expect(await ctx.env.BUCKET.head(key)).toBeNull();
			expect(
				(
					await control.query(
						'SELECT purge_state, purge_attempts FROM files WHERE id = $1',
						[fileId]
					)
				).rows
			).toEqual([{ purge_state: 'failed', purge_attempts: 1 }]);
			expect(await usage()).toBe('18');

			const restore = () =>
				run(
					Effect.flatMap(operations(), (files) =>
						Effect.result(files.restore(fileId))
					)
				);
			for (const retrash of [false, true]) {
				if (retrash) {
					await run(
						Effect.flatMap(operations(), (files) => files.trash(fileId))
					);
				}
				const restored = await restore();
				expect(restored._tag).toBe('Failure');
				if (restored._tag === 'Failure') {
					expect(restored.failure).toBeInstanceOf(InvalidRequest);
					if (restored.failure instanceof InvalidRequest) {
						expect(restored.failure.status).toBe(409);
					}
				}
			}
			const retained = await control.query<{ deleted_at: Date | null }>(
				'SELECT deleted_at FROM files WHERE id = $1',
				[fileId]
			);
			expect(retained.rows[0]?.deleted_at).not.toBeNull();
			expect(await usage()).toBe('18');

			failThumbnails = false;
			await run(
				Effect.flatMap(operations(), (files) => files.schedulePurgeNow(fileId))
			);
			for (let delivery = 0; delivery < 2; delivery += 1) {
				await run(
					Effect.flatMap(operations(), (files) => files.purgeOne(fileId))
				);
				expect(await usage()).toBe('17');
			}
			expect(
				(await control.query('SELECT id FROM files WHERE id = $1', [fileId]))
					.rows
			).toEqual([]);
		} finally {
			await cleanup();
		}
	});
});
