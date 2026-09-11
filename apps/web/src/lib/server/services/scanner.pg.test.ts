import type { Job } from '@adrive/shared';
import { Effect, Layer } from 'effect';
import { Client } from 'pg';
import { describe, expect, it } from 'vitest';
import { AppConfig, type AppConfigShape } from '../config';
import { StorageError } from '../errors';
import { PgSql } from '../pg';
import { markScanPending, recoverScanJobs } from '../scan-jobs';
import { TEST_DATABASE_URL } from '../test/database';
import { testPgLayer } from '../test/pg';
import { scanBlobs } from '../test/scan';
import { Blobs } from './blobs';
import { CloudflareCachePurge } from './cache-purge';
import { CurrentOrg } from './current-org';
import { JobQueue } from './jobs';
import { Scanner, ScannerLive, type ScanJob } from './scanner';
import {
	UrlReputation,
	urlReputationNull,
	type UrlReputationShape
} from './url-reputation';

const config: AppConfigShape = {
	dashboardOrigin: 'https://drive.example.test',
	contentDomain: 'files.example.test',
	contentScheme: 'https:',
	contentOriginFor: (slug) => `https://${slug}.files.example.test`,
	maxUploadBytes: 100 * 1024 * 1024,
	maintenanceSecret: 'scanner-test',
	workos: { apiKey: null, clientId: '', cookiePassword: '', webhookSecret: '' },
	urlScanner: null,
	cloudflareZone: null,
	adminUserIds: new Set(),
	semanticSearch: 'off',
	embeddingModel: '@cf/baai/bge-small-en-v1.5',
	embeddingPooling: 'cls',
	embeddingDimensions: 384
};

const setup = async (
	options: {
		public?: boolean;
		pending?: boolean;
		content?: string;
		contentType?: string;
		reputation?: UrlReputationShape;
	} = {}
) => {
	const orgId = `scan-${crypto.randomUUID()}`;
	const fileId = crypto.randomUUID();
	const control = new Client({ connectionString: TEST_DATABASE_URL });
	await control.connect();
	const bytes = new TextEncoder().encode(options.content ?? 'safe text');
	const key = `scan/${fileId}`;
	await control.query('INSERT INTO orgs (id, slug, name) VALUES ($1, $1, $1)', [
		orgId
	]);
	await control.query(
		`INSERT INTO files (id, org_id, display_name, content_type, size_bytes,
		public, publish_pending, created_at, updated_at)
		VALUES ($1, $2, 'scan.txt', $3, $4, $5, $6, now(), now())`,
		[
			fileId,
			orgId,
			options.contentType ?? 'text/plain',
			bytes.length,
			options.public ?? false,
			options.pending ?? true
		]
	);
	await control.query(
		`INSERT INTO file_versions (file_id, org_id, version, r2_key,
		size_bytes, content_type, created_at, scan_next_run_at)
		VALUES ($1, $2, 1, $3, $4, $5, now(), now() + interval '15 minutes')`,
		[fileId, orgId, key, bytes.length, options.contentType ?? 'text/plain']
	);
	const hooks = { beforeRead: (): Promise<void> => Promise.resolve() };
	const objects = new Map([[key, bytes]]);
	const originals = scanBlobs(objects);
	const sent: Job[] = [];
	const queue = { failing: false };
	const send: JobQueue['Service']['send'] = (job) =>
		Effect.suspend(() =>
			queue.failing
				? Effect.fail(
						new StorageError({
							operation: 'test enqueue',
							cause: 'queue offline'
						})
					)
				: Effect.sync(() => {
						sent.push(job);
					})
		);
	const jobs: JobQueue['Service'] = {
		send,
		trySend: (job) =>
			send(job).pipe(Effect.catchTag('StorageError', () => Effect.void))
	};
	const layer = ScannerLive.pipe(
		Layer.provide(
			Layer.mergeAll(
				testPgLayer(),
				Layer.succeed(AppConfig, config),
				Layer.succeed(CurrentOrg, { id: orgId, slug: orgId }),
				Layer.succeed(Blobs, {
					...originals,
					get: (key) =>
						originals
							.get(key)
							.pipe(Effect.tap(() => Effect.promise(hooks.beforeRead)))
				}),
				Layer.succeed(JobQueue, jobs),
				Layer.succeed(UrlReputation, options.reputation ?? urlReputationNull),
				Layer.succeed(CloudflareCachePurge, {
					enabled: false,
					purgeUrls: () => Effect.void,
					purgeHost: () => Effect.void
				})
			)
		)
	);
	const job: ScanJob = { kind: 'scan', orgId, fileId, version: 1 };
	const run = (input = job) =>
		Effect.runPromise(
			Effect.flatMap(Scanner, (scanner) => scanner.runOne(input)).pipe(
				Effect.provide(layer)
			)
		);
	const state = async () =>
		(
			await control.query(
				`SELECT f.public, f.publish_pending,
		f.quarantined, v.scan_next_run_at FROM files f JOIN file_versions v ON v.file_id = f.id
		WHERE f.id = $1 AND v.version = 1`,
				[fileId]
			)
		).rows[0];
	const kinds = async () =>
		(
			await control.query(
				'SELECT kind FROM notifications WHERE file_id = $1 ORDER BY created_at',
				[fileId]
			)
		).rows.map((row) => row.kind);
	const recover = () =>
		Effect.runPromise(
			Effect.flatMap(PgSql, (sql) =>
				recoverScanJobs(sql, jobs, orgId, 10)
			).pipe(Effect.provide(testPgLayer()))
		);
	const close = async () => {
		try {
			await control.query('DELETE FROM files WHERE org_id = $1', [orgId]);
			await control.query('DELETE FROM orgs WHERE id = $1', [orgId]);
		} finally {
			await control.end();
		}
	};
	return {
		orgId,
		fileId,
		control,
		objects,
		hooks,
		sent,
		queue,
		jobs,
		job,
		run,
		state,
		kinds,
		recover,
		close
	};
};

describe('scanner publication and delivery recovery', () => {
	it('holds publication when the required object is missing', async () => {
		const fixture = await setup();
		fixture.objects.clear();
		try {
			expect(await fixture.run()).toEqual({
				_tag: 'Settled',
				verdict: 'suspicious'
			});
			expect(await fixture.state()).toMatchObject({
				public: false,
				publish_pending: true,
				quarantined: false
			});
			expect(await fixture.kinds()).toEqual(['held']);
		} finally {
			await fixture.close();
		}
	});
	it.each(['cancel', 'admin-clean'] as const)(
		'respects a concurrent %s decision before finalization',
		async (decision) => {
			const fixture = await setup();
			const reading = Promise.withResolvers<void>();
			const resume = Promise.withResolvers<void>();
			fixture.hooks.beforeRead = () => {
				reading.resolve();
				return resume.promise;
			};
			const scanning = fixture.run();
			try {
				await Promise.race([
					reading.promise,
					scanning.then(() => {
						throw new Error(
							'Scan finished before reaching the controlled read'
						);
					})
				]);
				if (decision === 'cancel') {
					await fixture.control.query(
						'UPDATE files SET public = false, publish_pending = false WHERE id = $1',
						[fixture.fileId]
					);
				} else {
					await fixture.control.query(
						`INSERT INTO scan_verdicts (file_id, org_id, version, source, verdict)
					VALUES ($1, $2, 1, 'prior-check', 'malicious'), ($1, $2, 1, 'admin', 'clean')`,
						[fixture.fileId, fixture.orgId]
					);
				}
				resume.resolve();
				await scanning;
				expect(await fixture.state()).toEqual({
					public: decision === 'admin-clean',
					publish_pending: false,
					quarantined: false,
					scan_next_run_at: null
				});
				expect(await fixture.kinds()).toEqual(
					decision === 'cancel' ? [] : ['published']
				);
			} finally {
				resume.resolve();
				await scanning.catch(() => {});
				await fixture.close();
			}
		}
	);

	it('quarantines a malicious settled URL while another URL is still pending', async () => {
		const fixture = await setup({
			public: true,
			pending: false,
			reputation: {
				enabled: true,
				submit: () => Effect.die('Poll must not resubmit'),
				result: (id) =>
					Effect.succeed(
						id === 'bad'
							? {
									_tag: 'Settled' as const,
									verdict: 'malicious' as const,
									details: { id }
								}
							: { _tag: 'Pending' as const }
					)
			}
		});
		try {
			expect(
				await fixture.run({
					...fixture.job,
					urlScan: { ids: ['bad', 'pending'], attempt: 1 }
				})
			).toEqual({ _tag: 'Settled', verdict: 'malicious' });
			expect(await fixture.state()).toMatchObject({
				public: false,
				quarantined: true,
				scan_next_run_at: null
			});
			expect(fixture.sent).toEqual([]);
		} finally {
			await fixture.close();
		}
	});

	it('preserves an operator clean override when a blocked hash is scanned again', async () => {
		const fixture = await setup();
		const hash = Array.from(
			new Uint8Array(
				await crypto.subtle.digest(
					'SHA-256',
					new TextEncoder().encode('safe text')
				)
			),
			(byte) => byte.toString(16).padStart(2, '0')
		).join('');
		try {
			await fixture.control.query(
				'INSERT INTO blocked_hashes (sha256) VALUES ($1) ON CONFLICT DO NOTHING',
				[hash]
			);
			await fixture.control.query(
				`INSERT INTO scan_verdicts (file_id, org_id, version, source, verdict)
				VALUES ($1, $2, 1, 'admin', 'clean')`,
				[fixture.fileId, fixture.orgId]
			);
			expect(await fixture.run()).toEqual({
				_tag: 'Settled',
				verdict: 'clean'
			});
			expect(await fixture.state()).toMatchObject({
				public: true,
				quarantined: false
			});
		} finally {
			await fixture.control.query(
				'DELETE FROM blocked_hashes WHERE sha256 = $1',
				[hash]
			);
			await fixture.close();
		}
	});

	it.each(['submit', 'poll'] as const)(
		'fails a lost %s continuation so its consumer can retry',
		async (phase) => {
			const fixture = await setup({
				contentType: 'text/html',
				content:
					'<html><a href="https://outside.example.test/">link</a></html>',
				reputation: {
					enabled: true,
					submit: () => Effect.succeed('id'),
					result: () => Effect.succeed({ _tag: 'Pending' })
				}
			});
			fixture.queue.failing = true;
			try {
				const job =
					phase === 'submit'
						? fixture.job
						: { ...fixture.job, urlScan: { ids: ['id'], attempt: 1 } };
				await expect(fixture.run(job)).rejects.toMatchObject({
					_tag: 'StorageError'
				});
				expect((await fixture.state()).scan_next_run_at).not.toBeNull();
				fixture.queue.failing = false;
				expect(await fixture.run(job)).toMatchObject({ _tag: 'Polling' });
				expect(fixture.sent).toHaveLength(1);
			} finally {
				await fixture.close();
			}
		}
	);

	it('recovers a lost committed scan send, throttles resends, and clears the obligation after completion', async () => {
		const fixture = await setup();
		try {
			await Effect.runPromise(
				Effect.flatMap(PgSql, (sql) =>
					sql.withTransaction(
						markScanPending(sql, fixture.orgId, fixture.fileId, 1)
					)
				).pipe(Effect.provide(testPgLayer()))
			);
			fixture.queue.failing = true;
			await Effect.runPromise(fixture.jobs.trySend(fixture.job));
			expect(fixture.sent).toEqual([]);
			await fixture.control.query(
				"UPDATE file_versions SET scan_next_run_at = now() - interval '1 minute' WHERE file_id = $1",
				[fixture.fileId]
			);
			fixture.queue.failing = false;
			expect(await fixture.recover()).toBe(1);
			expect(fixture.sent).toEqual([fixture.job]);
			expect(await fixture.recover()).toBe(0);
			await fixture.run();
			expect(await fixture.state()).toMatchObject({
				public: true,
				scan_next_run_at: null
			});
			expect(await fixture.recover()).toBe(0);
		} finally {
			await fixture.close();
		}
	});

	it('does not clear a newer same-version scan request while an earlier read is in flight', async () => {
		const fixture = await setup();
		const reading = Promise.withResolvers<void>();
		const resume = Promise.withResolvers<void>();
		fixture.hooks.beforeRead = () => {
			reading.resolve();
			return resume.promise;
		};
		const scanning = fixture.run();
		try {
			await Promise.race([
				reading.promise,
				scanning.then(() => {
					throw new Error('Scan finished before reaching the controlled read');
				})
			]);
			await fixture.control.query(
				"UPDATE file_versions SET scan_next_run_at = now() + interval '30 minutes' WHERE file_id = $1",
				[fixture.fileId]
			);
			resume.resolve();
			await scanning;
			expect(await fixture.state()).toMatchObject({
				public: false,
				publish_pending: true
			});
			expect((await fixture.state()).scan_next_run_at).not.toBeNull();
			expect(await fixture.kinds()).toEqual([]);
		} finally {
			resume.resolve();
			await scanning.catch(() => {});
			await fixture.close();
		}
	});
});
