import type { Job } from '@adrive/shared';
import { Effect, Layer } from 'effect';
import { Client } from 'pg';
import { describe, expect, it, vi } from 'vitest';
import { AppConfig, type AppConfigShape } from '../config';
import { contentVersionAccess } from '../content-version-access';
import { StorageError } from '../errors';
import { PgSql } from '../pg';
import { markScanPending, recoverScanJobs } from '../scan-jobs';
import {
	SCAN_HTML_MAX_BYTES,
	SCAN_LINK_LIMIT,
	SCAN_SITE_ASSET_LIMIT
} from '../scan-policy';
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
	autumn: { secretKey: null, webhookSecret: '' },
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

const seedSite = async (
	fixture: Awaited<ReturnType<typeof setup>>,
	count: number,
	indexHtml: string
) => {
	await fixture.control.query('UPDATE files SET is_site = true WHERE id = $1', [
		fixture.fileId
	]);
	for (let index = 0; index < count; index++) {
		const path = index === 0 ? 'index.html' : `asset-${index}.txt`;
		const key = `scan/${fixture.fileId}/${path}`;
		const bytes = new TextEncoder().encode(
			index === 0 ? indexHtml : 'safe text'
		);
		fixture.objects.set(key, bytes);
		await fixture.control.query(
			`INSERT INTO site_assets (file_id, version, path, r2_key, content_type, size_bytes)
			VALUES ($1, 1, $2, $3, $4, $5)`,
			[
				fixture.fileId,
				path,
				key,
				index === 0 ? 'text/html' : 'text/plain',
				bytes.length
			]
		);
	}
};

describe('scanner bounded inspection', () => {
	const linkedHtml =
		'<html><a href="//links.example.test/first">link</a></html>';
	const manyLinks = (count: number) =>
		`<html>${Array.from(
			{ length: count },
			(_, index) => `<a href="https://links.example.test/${index}">link</a>`
		).join('')}</html>`;

	it.each([
		{ limit: 'assets', verdict: 'clean' },
		{ limit: 'assets', verdict: 'malicious' },
		{ limit: 'html', verdict: 'clean' },
		{ limit: 'html', verdict: 'malicious' },
		{ limit: 'links', verdict: 'clean' },
		{ limit: 'links', verdict: 'malicious' }
	] as const)(
		'keeps the $limit inspection floor after $verdict URL results',
		async ({ limit, verdict }) => {
			const submissions: string[] = [];
			const fixture = await setup({
				contentType: 'text/html',
				content:
					limit === 'html'
						? linkedHtml.padEnd(SCAN_HTML_MAX_BYTES + 1, ' ')
						: limit === 'links'
							? manyLinks(SCAN_LINK_LIMIT + 1)
							: linkedHtml,
				reputation: {
					enabled: true,
					submit: (url) =>
						Effect.sync(() => {
							submissions.push(url);
							return url;
						}),
					result: (id) =>
						Effect.succeed({ _tag: 'Settled', verdict, details: { id } })
				}
			});
			try {
				if (limit === 'assets')
					await seedSite(fixture, SCAN_SITE_ASSET_LIMIT + 1, linkedHtml);
				expect(await fixture.run()).toMatchObject({ _tag: 'Polling' });
				expect(submissions).toHaveLength(
					limit === 'links' ? SCAN_LINK_LIMIT : 1
				);
				const poll = fixture.sent[0];
				if (!poll || poll.kind !== 'scan')
					throw new Error('Expected scan continuation');
				expect(await fixture.run(poll)).toEqual({
					_tag: 'Settled',
					verdict: verdict === 'clean' ? 'suspicious' : 'malicious'
				});
				expect(await fixture.state()).toMatchObject({
					public: false,
					publish_pending: verdict === 'clean',
					quarantined: verdict === 'malicious',
					scan_next_run_at: null
				});
				const floor = await fixture.control.query(
					"SELECT verdict, details FROM scan_verdicts WHERE file_id = $1 AND source = 'inspection-limits'",
					[fixture.fileId]
				);
				expect(floor.rows).toEqual([
					{
						verdict: 'suspicious',
						details: {
							assetOverflow: limit === 'assets',
							assetLimit: SCAN_SITE_ASSET_LIMIT,
							truncatedHtml: limit === 'html' ? ['scan.txt'] : [],
							htmlByteLimit: SCAN_HTML_MAX_BYTES,
							linkOverflow: limit === 'links',
							linkLimit: SCAN_LINK_LIMIT
						}
					}
				]);
			} finally {
				await fixture.close();
			}
		}
	);

	it.each(['assets', 'html', 'links'] as const)(
		'publishes a complete inspection exactly at the %s cap',
		async (limit) => {
			const fixture = await setup({
				contentType: 'text/html',
				content:
					limit === 'html'
						? '<html>safe</html>'.padEnd(SCAN_HTML_MAX_BYTES, ' ')
						: limit === 'links'
							? manyLinks(SCAN_LINK_LIMIT)
							: '<html>safe</html>',
				reputation: {
					enabled: true,
					submit: (url) => Effect.succeed(url),
					result: (id) =>
						Effect.succeed({
							_tag: 'Settled',
							verdict: 'clean',
							details: { id }
						})
				}
			});
			try {
				if (limit === 'assets')
					await seedSite(fixture, SCAN_SITE_ASSET_LIMIT, '<html>safe</html>');
				const result = await fixture.run();
				if (result._tag === 'Polling') {
					const poll = fixture.sent[0];
					if (!poll || poll.kind !== 'scan')
						throw new Error('Expected scan continuation');
					expect(await fixture.run(poll)).toEqual({
						_tag: 'Settled',
						verdict: 'clean'
					});
				} else {
					expect(result).toEqual({ _tag: 'Settled', verdict: 'clean' });
				}
				expect(await fixture.state()).toMatchObject({
					public: true,
					publish_pending: false
				});
			} finally {
				await fixture.close();
			}
		}
	);

	it('counts distinct outbound links across site documents and lets admin review clear the hold', async () => {
		const submissions: string[] = [];
		const fixture = await setup({
			reputation: {
				enabled: true,
				submit: (url) =>
					Effect.sync(() => {
						submissions.push(url);
						return url;
					}),
				result: (id) =>
					Effect.succeed({ _tag: 'Settled', verdict: 'clean', details: { id } })
			}
		});
		try {
			await seedSite(fixture, 2, manyLinks(SCAN_LINK_LIMIT));
			const key = `scan/${fixture.fileId}/asset-1.txt`;
			const second = new TextEncoder().encode(
				'<html><base href="https://links.example.test/"><a href="0">duplicate</a><a href="last">extra</a></html>'
			);
			fixture.objects.set(key, second);
			await fixture.control.query(
				"UPDATE site_assets SET content_type = 'text/html', size_bytes = $2 WHERE r2_key = $1",
				[key, second.length]
			);
			await fixture.run();
			expect(submissions).toHaveLength(SCAN_LINK_LIMIT);
			const poll = fixture.sent[0];
			if (!poll || poll.kind !== 'scan')
				throw new Error('Expected scan continuation');
			expect(await fixture.run(poll)).toEqual({
				_tag: 'Settled',
				verdict: 'suspicious'
			});
			await fixture.control.query(
				`INSERT INTO scan_verdicts (file_id, org_id, version, source, verdict)
				VALUES ($1, $2, 1, 'admin', 'clean')`,
				[fixture.fileId, fixture.orgId]
			);
			fixture.sent.splice(0);
			await fixture.run();
			const retried = fixture.sent[0];
			if (!retried || retried.kind !== 'scan')
				throw new Error('Expected scan continuation');
			expect(await fixture.run(retried)).toEqual({
				_tag: 'Settled',
				verdict: 'clean'
			});
			expect(await fixture.state()).toMatchObject({
				public: true,
				publish_pending: false
			});
		} finally {
			await fixture.close();
		}
	});
});

describe('scanner publication and delivery recovery', () => {
	it.each(['clean', 'malicious'] as const)(
		'discards an in-flight stale %s poll after recovered work records the newer verdict',
		async (staleVerdict) => {
			const polling = Promise.withResolvers<void>();
			const resume = Promise.withResolvers<void>();
			const freshVerdict = staleVerdict === 'clean' ? 'malicious' : 'clean';
			const fixture = await setup({
				reputation: {
					enabled: true,
					submit: () => Effect.die('Poll must not resubmit'),
					result: (id) =>
						id === 'stale'
							? Effect.promise(() => {
									polling.resolve();
									return resume.promise;
								}).pipe(
									Effect.as({
										_tag: 'Settled' as const,
										verdict: staleVerdict,
										details: { id }
									})
								)
							: Effect.succeed({
									_tag: 'Settled' as const,
									verdict: freshVerdict,
									details: { id }
								})
				}
			});
			const marker = async () =>
				(
					await fixture.control.query<{ marker: string }>(
						'SELECT scan_next_run_at::text AS marker FROM file_versions WHERE file_id = $1',
						[fixture.fileId]
					)
				).rows[0]!.marker;
			const before = await marker();
			const staleJob = {
				...fixture.job,
				urlScan: { ids: ['stale'], attempt: 1, requestedAt: before }
			};
			const stale = fixture.run(staleJob);
			try {
				await Promise.race([
					polling.promise,
					stale.then(() => {
						throw new Error('Poll did not reach the controlled result');
					})
				]);
				await fixture.control.query(
					"UPDATE file_versions SET scan_next_run_at = now() - interval '1 minute' WHERE file_id = $1",
					[fixture.fileId]
				);
				expect(await fixture.recover()).toBe(1);
				const requestedAt = await marker();
				expect(requestedAt).not.toBe(before);
				expect(
					await fixture.run({
						...fixture.job,
						urlScan: { ids: ['fresh'], attempt: 1, requestedAt }
					})
				).toEqual({ _tag: 'Settled', verdict: freshVerdict });
				resume.resolve();
				expect(await stale).toEqual({ _tag: 'Skipped', reason: 'stale' });
				// A later redelivery is also stale; it must not restart and erase
				// the completed request's decision using old URL scan IDs.
				expect(await fixture.run(staleJob)).toEqual({
					_tag: 'Skipped',
					reason: 'stale'
				});
				expect(
					(
						await fixture.control.query(
							"SELECT verdict, details FROM scan_verdicts WHERE file_id = $1 AND source = 'urlscan'",
							[fixture.fileId]
						)
					).rows
				).toEqual([
					{
						verdict: freshVerdict,
						details: {
							links: [{ id: 'fresh' }],
							...(freshVerdict === 'malicious' ? { pending: 0 } : {})
						}
					}
				]);
				const access = await Effect.runPromise(
					Effect.flatMap(PgSql, (sql) => {
						const policy = contentVersionAccess(sql);
						return sql<{ allowed: boolean }>`SELECT ${policy.allowed} AS allowed
						FROM files f JOIN file_versions v ON v.file_id = f.id
						${policy.review} WHERE f.id = ${fixture.fileId} AND v.version = 1`;
					}).pipe(Effect.provide(testPgLayer()))
				);
				expect(access).toEqual([{ allowed: freshVerdict === 'clean' }]);
				expect(await fixture.state()).toMatchObject({
					public: freshVerdict === 'clean',
					quarantined: freshVerdict === 'malicious',
					scan_next_run_at: null
				});
				expect(await fixture.kinds()).toEqual([
					freshVerdict === 'clean' ? 'published' : 'quarantined'
				]);
			} finally {
				resume.resolve();
				await stale.catch(() => {});
				await fixture.close();
			}
		}
	);

	it('rechecks the marker after waiting for a version lock before writing verdicts', async () => {
		const fixture = await setup({
			reputation: {
				enabled: true,
				submit: () => Effect.die('Poll must not resubmit'),
				result: () =>
					Effect.succeed({ _tag: 'Settled', verdict: 'malicious', details: {} })
			}
		});
		let scanning: ReturnType<typeof fixture.run> | undefined;
		try {
			const marker = (
				await fixture.control.query<{ marker: string }>(
					'SELECT scan_next_run_at::text AS marker FROM file_versions WHERE file_id = $1',
					[fixture.fileId]
				)
			).rows[0]!.marker;
			await fixture.control.query('BEGIN');
			await fixture.control.query(
				'SELECT version FROM file_versions WHERE file_id = $1 FOR UPDATE',
				[fixture.fileId]
			);
			scanning = fixture.run({
				...fixture.job,
				urlScan: { ids: ['id'], attempt: 1, requestedAt: marker }
			});
			await vi.waitFor(
				async () => {
					await fixture.control.query('SELECT pg_stat_clear_snapshot()');
					const waiting = await fixture.control.query<{
						count: number;
					}>(`SELECT count(*)::int AS count
					FROM pg_stat_activity
					WHERE pg_backend_pid() = ANY(pg_blocking_pids(pid))
					AND query LIKE '%SELECT version FROM file_versions%'`);
					expect(waiting.rows[0]?.count).toBeGreaterThan(0);
				},
				{ timeout: 5_000, interval: 10 }
			);
			await fixture.control.query(
				"UPDATE file_versions SET scan_next_run_at = now() + interval '30 minutes' WHERE file_id = $1",
				[fixture.fileId]
			);
			await fixture.control.query('COMMIT');
			expect(await scanning).toEqual({ _tag: 'Skipped', reason: 'stale' });
			expect(
				(
					await fixture.control.query(
						'SELECT source FROM scan_verdicts WHERE file_id = $1',
						[fixture.fileId]
					)
				).rows
			).toEqual([]);
			expect((await fixture.state()).scan_next_run_at).not.toBeNull();
		} finally {
			await fixture.control.query('ROLLBACK');
			await scanning?.catch(() => {});
			await fixture.close();
		}
	});

	it('keeps a newer incomplete-submission verdict when a stale submission succeeds', async () => {
		const submitting = Promise.withResolvers<void>();
		const resume = Promise.withResolvers<void>();
		const fixture = await setup({
			contentType: 'text/html',
			content:
				'<html><a href="https://links.example.test/accepted">link</a></html>',
			reputation: {
				enabled: true,
				submit: () =>
					Effect.promise(() => {
						submitting.resolve();
						return resume.promise;
					}).pipe(Effect.as('accepted')),
				result: () => Effect.die('Stale submission must not enqueue a poll')
			}
		});
		const scanning = fixture.run();
		try {
			await Promise.race([
				submitting.promise,
				scanning.then(() => {
					throw new Error('Scan did not reach the controlled submission');
				})
			]);
			await fixture.control.query(
				"UPDATE file_versions SET scan_next_run_at = now() + interval '30 minutes' WHERE file_id = $1",
				[fixture.fileId]
			);
			await fixture.control.query(
				`INSERT INTO scan_verdicts (file_id, org_id, version, source, verdict)
				VALUES ($1, $2, 1, 'urlscan-submit', 'suspicious')`,
				[fixture.fileId, fixture.orgId]
			);
			resume.resolve();
			expect(await scanning).toEqual({ _tag: 'Skipped', reason: 'stale' });
			expect(
				(
					await fixture.control.query(
						"SELECT verdict FROM scan_verdicts WHERE file_id = $1 AND source = 'urlscan-submit'",
						[fixture.fileId]
					)
				).rows
			).toEqual([{ verdict: 'suspicious' }]);
			expect(fixture.sent).toEqual([]);
		} finally {
			resume.resolve();
			await scanning.catch(() => {});
			await fixture.close();
		}
	});

	it.each(['clean', 'malicious'] as const)(
		'polls successful submissions after a partial failure and preserves the %s result',
		async (verdict) => {
			const submissions: string[] = [];
			let failSubmission = true;
			const fixture = await setup({
				public: verdict === 'malicious',
				pending: verdict === 'clean',
				contentType: 'text/html',
				content:
					'<html><a href="https://links.example.test/accepted">one</a><a href="https://links.example.test/unavailable">two</a></html>',
				reputation: {
					enabled: true,
					submit: (url) =>
						Effect.suspend(() => {
							submissions.push(url);
							return failSubmission && url.endsWith('/unavailable')
								? Effect.fail(
										new StorageError({
											operation: 'submit URL',
											cause: 'provider offline'
										})
									)
								: Effect.succeed(url);
						}),
					result: (id) =>
						Effect.succeed({ _tag: 'Settled', verdict, details: { id } })
				}
			});
			try {
				expect(await fixture.run()).toEqual({
					_tag: 'Polling',
					ids: ['https://links.example.test/accepted']
				});
				const poll = fixture.sent[0];
				if (!poll || poll.kind !== 'scan')
					throw new Error('Expected scan continuation');
				expect(await fixture.run(poll)).toEqual({
					_tag: 'Settled',
					verdict: verdict === 'malicious' ? 'malicious' : 'suspicious'
				});
				expect(submissions).toHaveLength(2);
				expect(fixture.sent).toHaveLength(1);
				expect(await fixture.state()).toMatchObject({
					public: false,
					quarantined: verdict === 'malicious',
					publish_pending: verdict === 'clean',
					scan_next_run_at: null
				});
				expect(
					(
						await fixture.control.query(
							"SELECT verdict FROM scan_verdicts WHERE file_id = $1 AND source = 'urlscan-submit'",
							[fixture.fileId]
						)
					).rows
				).toEqual([{ verdict: 'suspicious' }]);
				if (verdict === 'clean') {
					// A later explicit rescan may clear the hold once every link
					// can be submitted; failed submissions do not retry forever.
					failSubmission = false;
					fixture.sent.splice(0);
					await fixture.run();
					const retried = fixture.sent[0];
					if (!retried || retried.kind !== 'scan')
						throw new Error('Expected retried scan continuation');
					expect(retried.urlScan?.requestedAt).toBeTypeOf('string');
					expect(await fixture.run(retried)).toEqual({
						_tag: 'Settled',
						verdict: 'clean'
					});
					expect(await fixture.state()).toMatchObject({
						public: true,
						publish_pending: false
					});
				}
			} finally {
				await fixture.close();
			}
		}
	);

	it('settles failed submissions without scheduling an empty poll or an automatic retry loop', async () => {
		const fixture = await setup({
			contentType: 'text/html',
			content:
				'<html><a href="https://links.example.test/unavailable">link</a></html>',
			reputation: {
				enabled: true,
				submit: () =>
					Effect.fail(
						new StorageError({
							operation: 'submit URL',
							cause: 'provider offline'
						})
					),
				result: () => Effect.die('No scan ids exist to poll')
			}
		});
		try {
			expect(await fixture.run()).toEqual({
				_tag: 'Settled',
				verdict: 'suspicious'
			});
			expect(fixture.sent).toEqual([]);
			expect(await fixture.state()).toMatchObject({
				public: false,
				publish_pending: true,
				scan_next_run_at: null
			});
			expect(await fixture.recover()).toBe(0);
		} finally {
			await fixture.close();
		}
	});

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
