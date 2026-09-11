import type { Job } from '@adrive/shared';
import { Context, Effect, Layer, Schema } from 'effect';
import { AppConfig } from '../config';
import { StorageError } from '../errors';
import { extractLinks } from '../html-links';
import { SNIFF_LENGTH, sniffMismatch } from '../mime-sniff';
import { inspectScanObject, isHtml, type ScanObject } from '../scan-inspection';
import { PgSql } from '../pg';
import {
	SCAN_HTML_MAX_BYTES,
	SCAN_LINK_LIMIT,
	SCAN_SITE_ASSET_LIMIT,
	URL_SCAN_POLL_DELAY_SECONDS,
	isScanVerdict,
	scanOutcome,
	shouldPollAgain,
	worstVerdict,
	type ScanVerdict
} from '../scan-policy';
import { Blobs } from './blobs';
import { CloudflareCachePurge, deleteFromWorkerCache } from './cache-purge';
import { CurrentOrg } from './current-org';
import { JobQueue } from './jobs';
import { UrlReputation } from './url-reputation';

// The scan pipeline. A scan job names one (file, version); the checks run
// in order (blocked hash, MIME sniff, outbound links through the URL
// Scanner), each recording a scan_verdicts row, and the worst verdict
// decides what happens to the row: a held publish goes live on `clean`,
// stays held on `suspicious` for a person to look at, and `malicious`
// quarantines the file and tells the owner. Nothing is dropped silently.

export type ScanJob = Extract<Job, { kind: 'scan' }>;

export type ScanRun =
	// The verdict is in and applied.
	| { readonly _tag: 'Settled'; readonly verdict: ScanVerdict }
	// URL scans were submitted; the job re-sent itself to collect them.
	| { readonly _tag: 'Polling'; readonly ids: ReadonlyArray<string> }
	// The version is gone or superseded; nothing to do.
	| { readonly _tag: 'Skipped'; readonly reason: string };

export interface ScannerShape {
	readonly runOne: (job: ScanJob) => Effect.Effect<ScanRun, StorageError>;
	// The URLs the edge may hold for a file, for purging when its
	// visibility changes.
	readonly contentUrls: (
		fileId: string,
		version: number
	) => Effect.Effect<ReadonlyArray<string>, StorageError>;
}

export class Scanner extends Context.Service<Scanner, ScannerShape>()(
	'app/Scanner'
) {}

const VersionRow = Schema.Struct({
	id: Schema.String,
	display_name: Schema.String,
	is_site: Schema.Boolean,
	public: Schema.Boolean,
	publish_pending: Schema.Boolean,
	quarantined: Schema.Boolean,
	current_version: Schema.Int,
	r2_key: Schema.String,
	size_bytes: Schema.Int,
	content_type: Schema.String,
	scan_next_run_at: Schema.NullOr(Schema.String)
});

const AssetRow = Schema.Struct({
	path: Schema.String,
	r2_key: Schema.String,
	content_type: Schema.String,
	size_bytes: Schema.Int
});

const decodeRows = <A, I>(schema: Schema.Codec<A, I, never>, rows: unknown) => {
	const decoded = Schema.decodeUnknownOption(Schema.Array(schema))(rows);
	return decoded._tag === 'Some' ? decoded.value : [];
};

const log = (entry: Record<string, unknown>) =>
	Effect.sync(() => {
		console.log(JSON.stringify(entry));
	});

const makeScanner = Effect.gen(function* () {
	const sql = yield* PgSql;
	const blobs = yield* Blobs;
	const config = yield* AppConfig;
	const org = yield* CurrentOrg;
	const jobs = yield* JobQueue;
	const reputation = yield* UrlReputation;
	const cdn = yield* CloudflareCachePurge;

	const storageError = (operation: string) =>
		Effect.mapError((cause: unknown) => new StorageError({ operation, cause }));

	const findVersion = Effect.fn('Scanner.findVersion')(function* (
		fileId: string,
		version: number,
		lock = false
	) {
		const rows = yield* sql`
			SELECT f.id, f.display_name, f.is_site, f.public, f.publish_pending,
				f.quarantined, f.current_version, v.r2_key, v.size_bytes,
				v.content_type, v.scan_next_run_at::text AS scan_next_run_at
			FROM files f
			JOIN file_versions v ON v.file_id = f.id AND v.version = ${version}
			WHERE f.id = ${fileId} AND f.org_id = ${org.id}
				AND f.deleted_at IS NULL
				AND (f.expires_at IS NULL OR f.expires_at > now())
				AND (NOT f.is_site OR f.current_version = ${version})
			LIMIT 1
			${lock ? sql`FOR UPDATE OF f` : sql``}
		`.pipe(storageError('find version to scan'));
		return decodeRows(VersionRow, rows)[0] ?? null;
	});

	const siteAssets = Effect.fn('Scanner.siteAssets')(function* (
		fileId: string,
		version: number
	) {
		const rows = yield* sql`
			SELECT path, r2_key, content_type, size_bytes
			FROM site_assets
			WHERE file_id = ${fileId} AND version = ${version}
			ORDER BY (path = 'index.html') DESC, size_bytes, path
			LIMIT ${SCAN_SITE_ASSET_LIMIT + 1}
		`.pipe(storageError('list site assets to scan'));
		return decodeRows(AssetRow, rows);
	});

	const record = Effect.fn('Scanner.record')(function* (
		fileId: string,
		version: number,
		source: string,
		verdict: ScanVerdict,
		details: Record<string, unknown>
	) {
		yield* sql`
			INSERT INTO scan_verdicts (file_id, org_id, version, verdict, source, details)
			VALUES (
				${fileId}, ${org.id}, ${version}, ${verdict}, ${source},
				${JSON.stringify(details)}::jsonb
			)
			ON CONFLICT (file_id, version, source) DO UPDATE
			SET verdict = EXCLUDED.verdict, details = EXCLUDED.details,
				created_at = now()
		`.pipe(storageError('record scan verdict'));
		return verdict;
	});

	const inspect = (object: ScanObject) => inspectScanObject(blobs, object);

	const blockedHashes = Effect.fn('Scanner.blockedHashes')(function* (
		hashes: ReadonlyArray<string>
	) {
		if (hashes.length === 0) return [];
		const rows = yield* sql<{ sha256: string }>`
			SELECT sha256 FROM blocked_hashes WHERE sha256 = ANY(${hashes}::text[])
		`.pipe(storageError('check blocked hashes'));
		return rows.map((row) => row.sha256);
	});

	const htmlText = Effect.fn('Scanner.htmlText')(function* (
		inspected: Effect.Success<ReturnType<typeof inspect>>
	) {
		if (inspected.missing || !isHtml(inspected.object.contentType)) return null;
		if (inspected.sha256 !== null) {
			return new TextDecoder().decode(
				inspected.bytes.subarray(0, SCAN_HTML_MAX_BYTES)
			);
		}
		return yield* blobs.readTextPrefix(
			inspected.object.r2Key,
			SCAN_HTML_MAX_BYTES
		);
	});

	const contentUrls = Effect.fn('Scanner.contentUrls')(function* (
		fileId: string,
		version: number
	) {
		const origin = config.contentOriginFor(org.slug);
		const urls = [
			`${origin}/f/${fileId}`,
			`${origin}/f/${fileId}?v=${version}`,
			`${origin}/f/${fileId}?preview=dashboard`,
			`${origin}/f/${fileId}?v=${version}&preview=dashboard`,
			`${origin}/t/${fileId}/${version}/grid.webp`,
			`${origin}/s/${fileId}/`
		];
		const assets = yield* siteAssets(fileId, version);
		for (const asset of assets)
			urls.push(`${origin}/s/${fileId}/${asset.path}`);
		return urls;
	});

	const purgeEdge = Effect.fn('Scanner.purgeEdge')(function* (
		fileId: string,
		version: number
	) {
		const urls = yield* contentUrls(fileId, version);
		yield* deleteFromWorkerCache(urls);
		yield* cdn.purgeUrls(urls);
	});

	const notify = Effect.fn('Scanner.notify')(function* (
		fileId: string,
		kind: string,
		message: string
	) {
		yield* sql`
			INSERT INTO notifications (id, org_id, kind, message, file_id)
			VALUES (${crypto.randomUUID()}, ${org.id}, ${kind}, ${message}, ${fileId})
		`.pipe(storageError('record notification'));
	});

	// Serialize the decision with visibility mutations and operator review.
	// A version-specific admin verdict takes precedence over automated
	// checks, including checks that were already running when it was set.
	const finalize = Effect.fn('Scanner.finalize')(function* (
		row: typeof VersionRow.Type,
		version: number
	) {
		const result = yield* sql
			.withTransaction(
				Effect.gen(function* () {
					const live = yield* findVersion(row.id, version, true);
					const rows = yield* sql<{ source: string; verdict: string }>`
				SELECT source, verdict FROM scan_verdicts
				WHERE file_id = ${row.id} AND org_id = ${org.id} AND version = ${version}
			`;
					const admin = rows.find((entry) => entry.source === 'admin');
					const verdict =
						admin && isScanVerdict(admin.verdict)
							? admin.verdict
							: worstVerdict(
									rows.map((entry) => entry.verdict).filter(isScanVerdict)
								);
					// A newer request (or a reconciliation resend) owns a different
					// marker. This scan must not clear it or apply stale URL results.
					if (!live || live.scan_next_run_at !== row.scan_next_run_at) {
						return { verdict, changed: false };
					}
					const current = version === live.current_version;
					const outcome = scanOutcome(verdict, live.publish_pending && current);
					let changed = false;
					switch (outcome._tag) {
						case 'Publish': {
							const updated = yield* sql<{ id: string }>`
						UPDATE files SET public = true, publish_pending = false
						WHERE id = ${row.id} AND org_id = ${org.id}
							AND current_version = ${version} AND quarantined = false
							AND publish_pending = true AND deleted_at IS NULL
							AND (expires_at IS NULL OR expires_at > now())
						RETURNING id
					`;
							changed = updated.length > 0;
							if (changed)
								yield* notify(
									row.id,
									'published',
									`${live.display_name} is now public`
								);
							break;
						}
						case 'Quarantine': {
							// Older ordinary file versions remain accessible through ?v=,
							// so a malicious retained version also takes the file offline.
							const updated = yield* sql<{ id: string }>`
						UPDATE files SET public = false, quarantined = true, publish_pending = false
						WHERE id = ${row.id} AND org_id = ${org.id}
							AND (NOT quarantined OR public OR publish_pending)
						RETURNING id
					`;
							changed = updated.length > 0;
							if (changed)
								yield* notify(
									row.id,
									'quarantined',
									`${live.display_name} was flagged as malicious and taken offline`
								);
							break;
						}
						case 'Hold': {
							if (
								live.publish_pending &&
								current &&
								live.scan_next_run_at !== null
							) {
								yield* notify(
									row.id,
									'held',
									`${live.display_name} is waiting for review before it goes public`
								);
							}
						}
					}
					yield* sql`
				UPDATE file_versions SET scan_next_run_at = NULL
				WHERE file_id = ${row.id} AND org_id = ${org.id} AND version = ${version}
					AND scan_next_run_at = ${row.scan_next_run_at}::timestamptz
			`;
					return { verdict, changed };
				})
			)
			.pipe(storageError('finalize content scan'));
		if (result.changed) yield* purgeEdge(row.id, version);
		yield* log({
			message: 'scan finished',
			orgId: org.id,
			fileId: row.id,
			version,
			verdict: result.verdict
		});
		return result.verdict;
	});

	// Collects URL Scanner results the job submitted earlier. A report
	// that is still pending re-sends the job; one that never arrives is a
	// `suspicious` hold, never a silent pass.
	const pollUrlScans = Effect.fn('Scanner.pollUrlScans')(function* (
		job: ScanJob,
		row: typeof VersionRow.Type,
		urlScan: NonNullable<ScanJob['urlScan']>
	) {
		const results = yield* Effect.forEach(urlScan.ids, (id) =>
			reputation.result(id).pipe(
				Effect.catchTag('StorageError', (failure) =>
					log({
						message: 'URL scan result unavailable',
						id,
						cause: String(failure.cause)
					}).pipe(Effect.as({ _tag: 'Pending' as const }))
				)
			)
		);
		const settled = results.flatMap((result) =>
			result._tag === 'Settled' ? [result] : []
		);
		const settledVerdict = worstVerdict(
			settled.map((result) => result.verdict)
		);
		if (settledVerdict === 'malicious') {
			yield* record(row.id, job.version, 'urlscan', 'malicious', {
				links: settled.map((result) => result.details),
				pending: results.length - settled.length
			});
		} else if (settled.length < results.length) {
			if (shouldPollAgain(urlScan.attempt)) {
				yield* jobs.send(
					{
						...job,
						urlScan: { ...urlScan, attempt: urlScan.attempt + 1 }
					},
					{ delaySeconds: URL_SCAN_POLL_DELAY_SECONDS }
				);
				return { _tag: 'Polling' as const, ids: urlScan.ids };
			}
			yield* record(row.id, job.version, 'urlscan', 'suspicious', {
				timedOut: true,
				ids: urlScan.ids,
				attempts: urlScan.attempt
			});
		} else {
			yield* record(row.id, job.version, 'urlscan', settledVerdict, {
				links: settled.map((result) => result.details)
			});
		}
		return {
			_tag: 'Settled' as const,
			verdict: yield* finalize(row, job.version)
		};
	});

	const runOne = Effect.fn('Scanner.runOne')(function* (job: ScanJob) {
		const row = yield* findVersion(job.fileId, job.version);
		if (row === null) {
			yield* log({
				message: 'scan skipped: version is gone',
				fileId: job.fileId,
				version: job.version
			});
			return { _tag: 'Skipped' as const, reason: 'missing' };
		}
		if (
			job.urlScan !== undefined &&
			(job.urlScan.requestedAt === undefined ||
				job.urlScan.requestedAt === row.scan_next_run_at)
		) {
			return yield* pollUrlScans(job, row, job.urlScan);
		}

		// What to look at: the file's object, or a site's assets.
		const objects: ReadonlyArray<ScanObject> = row.is_site
			? (yield* siteAssets(row.id, job.version))
					.slice(0, SCAN_SITE_ASSET_LIMIT)
					.map((asset) => ({
						path: asset.path,
						r2Key: asset.r2_key,
						contentType: asset.content_type,
						sizeBytes: asset.size_bytes
					}))
			: [
					{
						path: row.display_name,
						r2Key: row.r2_key,
						contentType: row.content_type,
						sizeBytes: row.size_bytes
					}
				];
		const inspected = yield* Effect.forEach(objects, inspect, {
			concurrency: 1
		});

		// 1. Known-bad hashes.
		const hashes = inspected.flatMap((entry) =>
			entry.sha256 === null ? [] : [entry.sha256]
		);
		if (!row.is_site) {
			const sha256 = inspected[0]?.sha256 ?? null;
			if (sha256 !== null) {
				yield* sql`
					UPDATE file_versions SET sha256 = ${sha256}
					WHERE file_id = ${row.id} AND version = ${job.version}
						AND org_id = ${org.id} AND sha256 IS NULL
				`.pipe(storageError('store version hash'));
			}
		}
		const blocked = yield* blockedHashes(hashes);
		yield* record(
			row.id,
			job.version,
			'hash',
			blocked.length > 0 ? 'malicious' : 'clean',
			{
				hashed: hashes.length,
				skipped: inspected.length - hashes.length,
				blocked
			}
		);

		// 2. Declared type versus the bytes.
		const mismatches = inspected.flatMap((entry) => {
			if (entry.missing) return [];
			const sniff = sniffMismatch(
				entry.bytes.subarray(0, SNIFF_LENGTH),
				entry.object.contentType
			);
			return sniff.verdict === 'clean'
				? []
				: [
						{
							path: entry.object.path,
							kind: sniff.kind,
							declared: sniff.declared
						}
					];
		});
		const missing = inspected.filter((entry) => entry.missing).length;
		yield* record(
			row.id,
			job.version,
			'sniff',
			mismatches.length > 0 || missing > 0 || objects.length === 0
				? 'suspicious'
				: 'clean',
			{ mismatches, missing, empty: objects.length === 0 }
		);
		if (blocked.length > 0) {
			return {
				_tag: 'Settled' as const,
				verdict: yield* finalize(row, job.version)
			};
		}

		// 3. Where published HTML sends people.
		const ownHost = new URL(config.contentOriginFor(org.slug)).host;
		const links = new Set<string>();
		for (const entry of inspected) {
			const html = yield* htmlText(entry);
			if (html === null) continue;
			for (const link of extractLinks(html, {
				limit: SCAN_LINK_LIMIT,
				ignoreHost: ownHost
			})) {
				links.add(link);
				if (links.size >= SCAN_LINK_LIMIT) break;
			}
			if (links.size >= SCAN_LINK_LIMIT) break;
		}
		if (links.size === 0 || !reputation.enabled) {
			yield* record(row.id, job.version, 'urlscan', 'clean', {
				links: [...links],
				skipped: links.size === 0 ? 'no-links' : 'not-configured'
			});
			return {
				_tag: 'Settled' as const,
				verdict: yield* finalize(row, job.version)
			};
		}
		const ids = yield* Effect.forEach([...links], (link) =>
			reputation.submit(link).pipe(
				Effect.catchTag('StorageError', (failure) =>
					log({
						message: 'URL scan submission failed',
						link,
						cause: String(failure.cause)
					}).pipe(Effect.as(null))
				)
			)
		);
		const submitted = ids.flatMap((id) => (id === null ? [] : [id]));
		if (submitted.length < ids.length) {
			// A link that could not be submitted is not cleared.
			yield* record(row.id, job.version, 'urlscan', 'suspicious', {
				links: [...links],
				submitted: submitted.length,
				failed: ids.length - submitted.length
			});
			return {
				_tag: 'Settled' as const,
				verdict: yield* finalize(row, job.version)
			};
		}
		yield* jobs.send(
			{
				...job,
				urlScan: {
					ids: submitted,
					attempt: 1,
					...(row.scan_next_run_at === null
						? {}
						: { requestedAt: row.scan_next_run_at })
				}
			},
			{ delaySeconds: URL_SCAN_POLL_DELAY_SECONDS }
		);
		return { _tag: 'Polling' as const, ids: submitted };
	});

	return Scanner.of({ runOne, contentUrls });
});

export const ScannerLive = Layer.effect(Scanner, makeScanner);
