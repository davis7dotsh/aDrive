import { AutumnNull } from './services/autumn';
import { BillingGatesLive } from './services/billing-gates';
import type { Job } from '@adrive/shared';
import { Cause, Effect, Exit, Layer } from 'effect';
import Pg from 'pg';
import { expect, it, vi } from 'vitest';
import { claimIndex } from './indexing-sql';
import { PgSql } from './pg';
import { MAX_INDEX_ATTEMPTS, newIndexLeaseToken } from './semantic-policy';
import { Blobs } from './services/blobs';
import { CurrentOrg } from './services/current-org';
import { Indexing, IndexingLive } from './services/indexing';
import { JobQueue } from './services/jobs';
import { EmbedderNull, VectorIndexNull } from './services/semantic';
import { TEST_DATABASE_URL } from './test/database';
import { testPgLayer } from './test/pg';

const reconciliationLayer = (orgId: string, jobs: Job[]) => {
	const send = (job: Job) =>
		Effect.sync(() => {
			jobs.push(job);
		});
	const unexpectedBlobOperation = () =>
		Effect.die('Index reconciliation must only enqueue work');
	return IndexingLive.pipe(
		Layer.provide(
			Layer.mergeAll(
				BillingGatesLive.pipe(Layer.provide(AutumnNull)),
				testPgLayer(),
				Layer.succeed(CurrentOrg, { id: orgId, slug: 'index-reconcile' }),
				Layer.succeed(JobQueue, { send, trySend: send }),
				EmbedderNull,
				VectorIndexNull,
				Layer.succeed(Blobs, {
					put: unexpectedBlobOperation,
					get: unexpectedBlobOperation,
					head: unexpectedBlobOperation,
					getIfChanged: unexpectedBlobOperation,
					readTextPrefix: unexpectedBlobOperation,
					delete: unexpectedBlobOperation,
					deleteMany: unexpectedBlobOperation,
					deletePrefixes: unexpectedBlobOperation
				})
			)
		)
	);
};

it.each(['pending', 'running'])(
	'keeps a concurrent consumer lease while reconciling other stuck %s rows',
	async (state) => {
		const suffix = crypto.randomUUID();
		const orgId = `org_reconcile_${suffix}`;
		const lockedId = `index_locked_${suffix}`;
		const dueId = `index_due_${suffix}`;
		const token = newIndexLeaseToken();
		const now = new Date();
		const leaseUntil = new Date(now.getTime() + 5 * 60_000).toISOString();
		const staleAt = new Date(now.getTime() - 60 * 60_000).toISOString();
		const control = new Pg.Client({ connectionString: TEST_DATABASE_URL });
		const releaseConsumer = Promise.withResolvers<void>();
		const claimed = Promise.withResolvers<boolean>();
		const jobs: Job[] = [];
		const layer = reconciliationLayer(orgId, jobs);
		const reconcile = () =>
			Effect.runPromiseExit(
				Effect.flatMap(Indexing, (indexing) => indexing.runDue(10)).pipe(
					Effect.provide(layer)
				)
			);
		const operations: Promise<unknown>[] = [];
		await control.connect();
		try {
			await control.query(
				'INSERT INTO orgs (id, slug, name) VALUES ($1, $1, $1)',
				[orgId]
			);
			for (const id of [lockedId, dueId]) {
				await control.query(
					`INSERT INTO files (id, org_id, display_name, content_type, size_bytes,
						created_at, updated_at, current_version, index_state, index_next_run_at)
					VALUES ($1, $2, 'reconcile.txt', 'text/plain', 0, $3, $3, 3, $4, $3)`,
					[id, orgId, staleAt, state]
				);
			}
			// Use the real consumer claim, but hold its transaction open so the
			// sweep's snapshot still sees the old stale row while it is locked.
			const consumer = Effect.runPromiseExit(
				Effect.flatMap(PgSql, (sql) =>
					sql.withTransaction(
						Effect.gen(function* () {
							const owned = yield* claimIndex(
								sql,
								{
									orgId,
									fileId: lockedId,
									version: 3,
									attempt: 1,
									token
								},
								now.toISOString(),
								leaseUntil,
								MAX_INDEX_ATTEMPTS
							);
							claimed.resolve(owned);
							yield* Effect.promise(() => releaseConsumer.promise);
						})
					)
				).pipe(Effect.provide(testPgLayer()))
			);
			operations.push(consumer);
			let ownsRow: boolean | undefined;
			void claimed.promise.then((value) => {
				ownsRow = value;
			});
			await vi.waitFor(() => expect(ownsRow).toBe(true), { timeout: 5_000 });
			const sweep = reconcile();
			operations.push(sweep);
			let finished = false;
			void sweep.then(() => {
				finished = true;
			});
			// The sweep must finish without waiting for the consumer and still
			// enqueue the unlocked row. An UPDATE that waits would clobber the
			// fresh lease after the consumer commits.
			await vi.waitFor(() => expect(finished).toBe(true), { timeout: 5_000 });
			const swept = await sweep;
			expect(
				Exit.isSuccess(swept),
				Exit.isFailure(swept) ? Cause.pretty(swept.cause) : undefined
			).toBe(true);
			if (Exit.isSuccess(swept)) expect(swept.value).toBe(1);
			expect(jobs).toEqual([
				{ kind: 'index', orgId, fileId: dueId, version: 3 }
			]);
			releaseConsumer.resolve();
			const consumed = await consumer;
			expect(
				Exit.isSuccess(consumed),
				Exit.isFailure(consumed) ? Cause.pretty(consumed.cause) : undefined
			).toBe(true);
			expect(
				(
					await control.query(
						`SELECT index_state, index_attempts, index_lease_token,
					index_next_run_at FROM files WHERE id = $1`,
						[lockedId]
					)
				).rows
			).toEqual([
				{
					index_state: 'running',
					index_attempts: 1,
					index_lease_token: token,
					index_next_run_at: new Date(leaseUntil)
				}
			]);
			const repeated = await reconcile();
			expect(Exit.isSuccess(repeated)).toBe(true);
			if (Exit.isSuccess(repeated)) expect(repeated.value).toBe(0);
			expect(jobs).toHaveLength(1);
		} finally {
			releaseConsumer.resolve();
			await Promise.all(operations);
			try {
				await control.query('DELETE FROM files WHERE org_id = $1', [orgId]);
				await control.query('DELETE FROM orgs WHERE id = $1', [orgId]);
			} finally {
				await control.end();
			}
		}
	}
);

it('closes an expired final lease without touching live leases or another organization', async () => {
	const suffix = crypto.randomUUID();
	const orgId = `org_final_${suffix}`;
	const otherOrgId = `org_other_final_${suffix}`;
	const staleAt = new Date(Date.now() - 60 * 60_000).toISOString();
	const leaseUntil = new Date(Date.now() + 5 * 60_000).toISOString();
	const expired = { id: `final_expired_${suffix}`, orgId, at: staleAt };
	const live = { id: `final_live_${suffix}`, orgId, at: leaseUntil };
	const other = { id: `final_other_${suffix}`, orgId: otherOrgId, at: staleAt };
	const retryableId = `retryable_${suffix}`;
	const jobs: Job[] = [];
	const layer = reconciliationLayer(orgId, jobs);
	const reconcile = () =>
		Effect.runPromise(
			Effect.flatMap(Indexing, (indexing) => indexing.runDue(10)).pipe(
				Effect.provide(layer)
			)
		);
	const control = new Pg.Client({ connectionString: TEST_DATABASE_URL });
	await control.connect();
	try {
		await control.query(
			'INSERT INTO orgs (id, slug, name) VALUES ($1, $1, $1), ($2, $2, $2)',
			[orgId, otherOrgId]
		);
		for (const row of [expired, live, other]) {
			await control.query(
				`INSERT INTO files (id, org_id, display_name, content_type, size_bytes,
					created_at, updated_at, index_state, index_attempts, index_next_run_at, index_lease_token)
				VALUES ($1, $2, 'final.txt', 'text/plain', 0, $3, $3, 'running', $4, $5, $1)`,
				[row.id, row.orgId, staleAt, MAX_INDEX_ATTEMPTS, row.at]
			);
		}
		await control.query(
			`INSERT INTO files (id, org_id, display_name, content_type, size_bytes,
				created_at, updated_at, index_state, index_attempts, index_next_run_at)
			VALUES ($1, $2, 'retryable.txt', 'text/plain', 0, $3, $3, 'running', $4, $3)`,
			[retryableId, orgId, staleAt, MAX_INDEX_ATTEMPTS - 1]
		);
		expect(await reconcile()).toBe(1);
		expect(jobs).toEqual([
			{ kind: 'index', orgId, fileId: retryableId, version: 1 }
		]);
		expect(
			(
				await control.query(
					`SELECT index_state, index_attempts, index_error, index_next_run_at, index_lease_token
			FROM files WHERE id = $1`,
					[expired.id]
				)
			).rows
		).toEqual([
			{
				index_state: 'failed',
				index_attempts: MAX_INDEX_ATTEMPTS,
				index_error: 'Indexing lease expired after the final attempt',
				index_next_run_at: null,
				index_lease_token: null
			}
		]);
		for (const row of [live, other]) {
			expect(
				(
					await control.query(
						`SELECT index_state, index_attempts, index_error, index_next_run_at, index_lease_token
				FROM files WHERE id = $1`,
						[row.id]
					)
				).rows
			).toEqual([
				{
					index_state: 'running',
					index_attempts: MAX_INDEX_ATTEMPTS,
					index_error: null,
					index_next_run_at: new Date(row.at),
					index_lease_token: row.id
				}
			]);
		}
		expect(await reconcile()).toBe(0);
		expect(jobs).toHaveLength(1);
	} finally {
		try {
			await control.query('DELETE FROM files WHERE org_id = ANY($1::text[])', [
				[orgId, otherOrgId]
			]);
			await control.query('DELETE FROM orgs WHERE id = ANY($1::text[])', [
				[orgId, otherOrgId]
			]);
		} finally {
			await control.end();
		}
	}
});
