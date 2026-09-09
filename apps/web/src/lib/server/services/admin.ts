import { Context, Effect, Layer, Schema } from 'effect';
import { AppConfig } from '../config';
import { forgetContentSlug } from '../content-host';
import { InvalidRequest, NotFound, StorageError } from '../errors';
import { PgSql } from '../pg';
import { type Resolution } from '../report-policy';
import { isScanVerdict, type ScanVerdict } from '../scan-policy';
import { type TrustLevel } from '../trust-policy';
import { AuthGuardStore } from './bindings';
import { CloudflareCachePurge, deleteFromWorkerCache } from './cache-purge';

// Operator actions. Nothing here is scoped to the current org: the admin
// acts across tenants from the dashboard origin (/admin, request-auth.ts
// requireAdmin), so every statement names its org explicitly and none of
// them run inside an org-pinned transaction.

const OrgRow = Schema.Struct({
	id: Schema.String,
	slug: Schema.String,
	name: Schema.String,
	trust: Schema.String,
	plan: Schema.String,
	created_at: Schema.String,
	stored_bytes: Schema.Int,
	file_count: Schema.Int
});

const ReportRow = Schema.Struct({
	id: Schema.String,
	org_id: Schema.String,
	org_slug: Schema.NullOr(Schema.String),
	file_id: Schema.String,
	version: Schema.NullOr(Schema.Int),
	reason: Schema.String,
	details: Schema.NullOr(Schema.String),
	reporter_ip_hash: Schema.String,
	created_at: Schema.String,
	resolved_at: Schema.NullOr(Schema.String),
	resolution: Schema.NullOr(Schema.String),
	file_name: Schema.NullOr(Schema.String),
	file_public: Schema.NullOr(Schema.Boolean),
	file_quarantined: Schema.NullOr(Schema.Boolean),
	file_publish_pending: Schema.NullOr(Schema.Boolean)
});

const HeldFileRow = Schema.Struct({
	id: Schema.String,
	org_id: Schema.String,
	org_slug: Schema.String,
	display_name: Schema.String,
	content_type: Schema.String,
	current_version: Schema.Int,
	public: Schema.Boolean,
	quarantined: Schema.Boolean,
	publish_pending: Schema.Boolean,
	updated_at: Schema.String,
	verdicts: Schema.Array(
		Schema.Struct({
			source: Schema.String,
			verdict: Schema.String,
			details: Schema.Unknown
		})
	)
});

const FailedJobRow = Schema.Struct({
	id: Schema.String,
	org_id: Schema.NullOr(Schema.String),
	kind: Schema.String,
	payload: Schema.Unknown,
	error: Schema.String,
	attempts: Schema.Int,
	failed_at: Schema.String,
	resolved_at: Schema.NullOr(Schema.String)
});

const decodeRows = <A, I>(schema: Schema.Codec<A, I, never>, rows: unknown) => {
	const decoded = Schema.decodeUnknownOption(Schema.Array(schema))(rows);
	return decoded._tag === 'Some' ? decoded.value : [];
};

export interface AdminOrg {
	readonly id: string;
	readonly slug: string;
	readonly name: string;
	readonly trust: string;
	readonly plan: string;
	readonly createdAt: string;
	readonly storedBytes: number;
	readonly fileCount: number;
}

export interface AdminReport {
	readonly id: string;
	readonly orgId: string;
	readonly orgSlug: string | null;
	readonly fileId: string;
	readonly version: number | null;
	readonly reason: string;
	readonly details: string | null;
	readonly reporter: string;
	readonly createdAt: string;
	readonly resolvedAt: string | null;
	readonly resolution: string | null;
	readonly file: {
		readonly name: string;
		readonly public: boolean;
		readonly quarantined: boolean;
		readonly publishPending: boolean;
	} | null;
}

export interface AdminHeldFile {
	readonly id: string;
	readonly orgId: string;
	readonly orgSlug: string;
	readonly name: string;
	readonly contentType: string;
	readonly version: number;
	readonly public: boolean;
	readonly quarantined: boolean;
	readonly publishPending: boolean;
	readonly updatedAt: string;
	readonly verdicts: ReadonlyArray<{
		readonly source: string;
		readonly verdict: string;
		readonly details: unknown;
	}>;
}

export interface AdminFailedJob {
	readonly id: string;
	readonly orgId: string | null;
	readonly kind: string;
	readonly payload: unknown;
	readonly error: string;
	readonly attempts: number;
	readonly failedAt: string;
	readonly resolvedAt: string | null;
}

export interface AdminOverview {
	readonly reports: ReadonlyArray<AdminReport>;
	readonly held: ReadonlyArray<AdminHeldFile>;
	readonly failedJobs: ReadonlyArray<AdminFailedJob>;
	readonly orgs: ReadonlyArray<AdminOrg>;
}

export interface AdminShape {
	readonly overview: Effect.Effect<AdminOverview, StorageError>;
	// Records a report from the content host. NotFound when the file is not
	// one the host serves (or ever served: trashed and quarantined files
	// can still be reported).
	readonly fileReport: (input: {
		readonly orgId: string;
		readonly fileId: string;
		readonly reason: string;
		readonly details: string | null;
		readonly reporterIpHash: string;
	}) => Effect.Effect<string, NotFound | StorageError>;
	readonly resolveReport: (
		id: string,
		resolution: Resolution
	) => Effect.Effect<void, NotFound | StorageError>;
	// The kill switch. The host answers 404 for every path, credentials for
	// the org stop resolving, and the edge forgets the host.
	readonly suspendOrg: (
		orgId: string
	) => Effect.Effect<AdminOrg, NotFound | StorageError>;
	// Reverses suspendOrg; the org comes back as verified.
	readonly restoreOrg: (
		orgId: string
	) => Effect.Effect<AdminOrg, NotFound | StorageError>;
	readonly setTrust: (
		orgId: string,
		trust: Exclude<TrustLevel, 'suspended'>
	) => Effect.Effect<AdminOrg, NotFound | StorageError>;
	// An operator's verdict on a held or quarantined file. `clean` clears
	// the quarantine and publishes a held row; `malicious` quarantines.
	readonly markFile: (
		fileId: string,
		verdict: Exclude<ScanVerdict, 'suspicious'>
	) => Effect.Effect<void, NotFound | StorageError>;
	readonly blockHash: (
		sha256: string,
		reason: string,
		addedBy: string
	) => Effect.Effect<void, InvalidRequest | StorageError>;
}

export class Admin extends Context.Service<Admin, AdminShape>()('app/Admin') {}

const toOrg = (row: typeof OrgRow.Type): AdminOrg => ({
	id: row.id,
	slug: row.slug,
	name: row.name,
	trust: row.trust,
	plan: row.plan,
	createdAt: row.created_at,
	storedBytes: row.stored_bytes,
	fileCount: row.file_count
});

const toReport = (row: typeof ReportRow.Type): AdminReport => ({
	id: row.id,
	orgId: row.org_id,
	orgSlug: row.org_slug,
	fileId: row.file_id,
	version: row.version,
	reason: row.reason,
	details: row.details,
	reporter: row.reporter_ip_hash.slice(0, 12),
	createdAt: row.created_at,
	resolvedAt: row.resolved_at,
	resolution: row.resolution,
	file:
		row.file_name === null
			? null
			: {
					name: row.file_name,
					public: row.file_public ?? false,
					quarantined: row.file_quarantined ?? false,
					publishPending: row.file_publish_pending ?? false
				}
});

const orgSelect = `
	SELECT o.id, o.slug, o.name, o.trust, o.plan, o.created_at,
		COALESCE(u.stored_bytes, 0) AS stored_bytes,
		COALESCE(u.file_count, 0) AS file_count
	FROM orgs o
	LEFT JOIN org_usage u ON u.org_id = o.id
`;

const makeAdmin = Effect.gen(function* () {
	const sql = yield* PgSql;
	const config = yield* AppConfig;
	const store = yield* AuthGuardStore;
	const cdn = yield* CloudflareCachePurge;

	const storageError = (operation: string) =>
		Effect.mapError((cause: unknown) => new StorageError({ operation, cause }));

	const loadOrg = Effect.fn('Admin.loadOrg')(function* (orgId: string) {
		const rows = yield* sql`
			${sql.literal(orgSelect)} WHERE o.id = ${orgId} LIMIT 1
		`.pipe(storageError('load org'));
		const row = decodeRows(OrgRow, rows)[0];
		if (!row) return yield* new NotFound({ id: orgId });
		return toOrg(row);
	});

	const setOrgTrust = Effect.fn('Admin.setOrgTrust')(function* (
		orgId: string,
		trust: TrustLevel
	) {
		const rows = yield* sql<{ slug: string }>`
			UPDATE orgs SET trust = ${trust} WHERE id = ${orgId} RETURNING slug
		`.pipe(storageError('set org trust'));
		const row = rows[0];
		if (!row) return yield* new NotFound({ id: orgId });
		// The host gate caches the slug with its trust; drop it so the change
		// is live on the next request rather than in five minutes.
		yield* forgetContentSlug(row.slug).pipe(
			Effect.provideService(AuthGuardStore, store)
		);
		return row.slug;
	});

	const fileOrgAndVersion = Effect.fn('Admin.fileOrgAndVersion')(function* (
		fileId: string
	) {
		const rows = yield* sql<{
			org_id: string;
			slug: string;
			current_version: number;
			display_name: string;
		}>`
			SELECT f.org_id, o.slug, f.current_version, f.display_name
			FROM files f JOIN orgs o ON o.id = f.org_id
			WHERE f.id = ${fileId} LIMIT 1
		`.pipe(storageError('find file for admin action'));
		const row = rows[0];
		if (!row) return yield* new NotFound({ id: fileId });
		return row;
	});

	const purgeFile = Effect.fn('Admin.purgeFile')(function* (
		slug: string,
		fileId: string,
		version: number
	) {
		const origin = config.contentOriginFor(slug);
		const assets = yield* sql<{ path: string }>`
			SELECT path FROM site_assets WHERE file_id = ${fileId} AND version = ${version}
		`.pipe(storageError('list site assets to purge'));
		const urls = [
			`${origin}/f/${fileId}`,
			`${origin}/f/${fileId}?v=${version}`,
			`${origin}/f/${fileId}?preview=dashboard`,
			`${origin}/f/${fileId}?v=${version}&preview=dashboard`,
			`${origin}/t/${fileId}/${version}/grid.webp`,
			`${origin}/s/${fileId}/`,
			...assets.map((asset) => `${origin}/s/${fileId}/${asset.path}`)
		];
		yield* deleteFromWorkerCache(urls);
		yield* cdn.purgeUrls(urls);
	});

	const notify = Effect.fn('Admin.notify')(function* (
		orgId: string,
		fileId: string,
		kind: string,
		message: string
	) {
		yield* sql`
			INSERT INTO notifications (id, org_id, kind, message, file_id)
			VALUES (${crypto.randomUUID()}, ${orgId}, ${kind}, ${message}, ${fileId})
		`.pipe(storageError('record notification'));
	});

	const overview = Effect.gen(function* () {
		const [reportRows, heldRows, failedRows, orgRows] = yield* Effect.all(
			[
				sql`
					SELECT r.id, r.org_id, o.slug AS org_slug, r.file_id, r.version,
						r.reason, r.details, r.reporter_ip_hash, r.created_at,
						r.resolved_at, r.resolution,
						f.display_name AS file_name, f.public AS file_public,
						f.quarantined AS file_quarantined,
						f.publish_pending AS file_publish_pending
					FROM reports r
					LEFT JOIN orgs o ON o.id = r.org_id
					LEFT JOIN files f ON f.id = r.file_id
					WHERE r.resolved_at IS NULL
					ORDER BY r.created_at DESC
					LIMIT 200`,
				sql`
					SELECT f.id, f.org_id, o.slug AS org_slug, f.display_name,
						f.content_type, f.current_version, f.public, f.quarantined,
						f.publish_pending, f.updated_at,
						COALESCE((
							SELECT jsonb_agg(jsonb_build_object(
								'source', v.source, 'verdict', v.verdict, 'details', v.details
							) ORDER BY v.source)
							FROM scan_verdicts v
							WHERE v.file_id = f.id AND v.version = f.current_version
						), '[]'::jsonb) AS verdicts
					FROM files f
					JOIN orgs o ON o.id = f.org_id
					WHERE (f.quarantined OR f.publish_pending) AND f.deleted_at IS NULL
					ORDER BY f.updated_at DESC
					LIMIT 200`,
				sql`
					SELECT id, org_id, kind, payload, error, attempts, failed_at,
						resolved_at
					FROM failed_jobs
					WHERE resolved_at IS NULL
					ORDER BY failed_at DESC
					LIMIT 100`,
				sql`${sql.literal(orgSelect)} ORDER BY o.created_at DESC LIMIT 100`
			],
			{ concurrency: 'unbounded' }
		).pipe(storageError('load admin overview'));
		return {
			reports: decodeRows(ReportRow, reportRows).map(toReport),
			held: decodeRows(HeldFileRow, heldRows).map((row): AdminHeldFile => ({
				id: row.id,
				orgId: row.org_id,
				orgSlug: row.org_slug,
				name: row.display_name,
				contentType: row.content_type,
				version: row.current_version,
				public: row.public,
				quarantined: row.quarantined,
				publishPending: row.publish_pending,
				updatedAt: row.updated_at,
				verdicts: row.verdicts
			})),
			failedJobs: decodeRows(FailedJobRow, failedRows).map(
				(row): AdminFailedJob => ({
					id: row.id,
					orgId: row.org_id,
					kind: row.kind,
					payload: row.payload,
					error: row.error,
					attempts: row.attempts,
					failedAt: row.failed_at,
					resolvedAt: row.resolved_at
				})
			),
			orgs: decodeRows(OrgRow, orgRows).map(toOrg)
		} satisfies AdminOverview;
	}).pipe(Effect.withSpan('Admin.overview'));

	return Admin.of({
		overview,
		fileReport: Effect.fn('Admin.fileReport')(function* (input) {
			const id = crypto.randomUUID();
			const rows = yield* sql<{ id: string }>`
				INSERT INTO reports (
					id, org_id, file_id, version, reason, reporter_ip_hash, details
				)
				SELECT ${id}, f.org_id, f.id, f.current_version, ${input.reason},
					${input.reporterIpHash}, ${input.details}
				FROM files f
				WHERE f.id = ${input.fileId} AND f.org_id = ${input.orgId}
				RETURNING id
			`.pipe(storageError('record report'));
			if (rows.length !== 1) return yield* new NotFound({ id: input.fileId });
			return id;
		}),
		resolveReport: Effect.fn('Admin.resolveReport')(function* (id, resolution) {
			const rows = yield* sql<{ id: string }>`
				UPDATE reports
				SET resolved_at = now(), resolution = ${resolution}
				WHERE id = ${id} AND resolved_at IS NULL
				RETURNING id
			`.pipe(storageError('resolve report'));
			if (rows.length !== 1) return yield* new NotFound({ id });
		}),
		suspendOrg: Effect.fn('Admin.suspendOrg')(function* (orgId) {
			const slug = yield* setOrgTrust(orgId, 'suspended');
			// The Worker's own cache is keyed by full URL; the zone purge covers
			// everything the CDN holds for the host.
			yield* cdn.purgeHost(new URL(config.contentOriginFor(slug)).host);
			yield* Effect.sync(() => {
				console.log(JSON.stringify({ message: 'org suspended', orgId, slug }));
			});
			return yield* loadOrg(orgId);
		}),
		restoreOrg: Effect.fn('Admin.restoreOrg')(function* (orgId) {
			const current = yield* loadOrg(orgId);
			if (current.trust === 'suspended') {
				yield* setOrgTrust(orgId, 'verified');
			}
			yield* Effect.sync(() => {
				console.log(JSON.stringify({ message: 'org restored', orgId }));
			});
			return yield* loadOrg(orgId);
		}),
		setTrust: Effect.fn('Admin.setTrust')(function* (orgId, trust) {
			yield* setOrgTrust(orgId, trust);
			return yield* loadOrg(orgId);
		}),
		markFile: Effect.fn('Admin.markFile')(function* (fileId, verdict) {
			const file = yield* fileOrgAndVersion(fileId);
			yield* sql`
				INSERT INTO scan_verdicts (file_id, org_id, version, verdict, source, details)
				VALUES (
					${fileId}, ${file.org_id}, ${file.current_version}, ${verdict},
					'admin', '{}'::jsonb
				)
				ON CONFLICT (file_id, version, source) DO UPDATE
				SET verdict = EXCLUDED.verdict, created_at = now()
			`.pipe(storageError('record admin verdict'));
			if (verdict === 'malicious') {
				yield* sql`
					UPDATE files
					SET public = false, quarantined = true, publish_pending = false
					WHERE id = ${fileId}
				`.pipe(storageError('quarantine file'));
				yield* notify(
					file.org_id,
					fileId,
					'quarantined',
					`${file.display_name} was taken offline after review`
				);
			} else {
				// A held publish goes live; a quarantine is lifted back to
				// private so the owner decides again.
				yield* sql`
					UPDATE files
					SET public = (public OR publish_pending) AND NOT quarantined,
						quarantined = false, publish_pending = false
					WHERE id = ${fileId}
				`.pipe(storageError('clear file'));
				yield* notify(
					file.org_id,
					fileId,
					'cleared',
					`${file.display_name} was reviewed and cleared`
				);
			}
			yield* purgeFile(file.slug, fileId, file.current_version);
		}),
		blockHash: Effect.fn('Admin.blockHash')(
			function* (sha256, reason, addedBy) {
				const normalized = sha256.trim().toLowerCase();
				if (!/^[0-9a-f]{64}$/.test(normalized)) {
					return yield* new InvalidRequest({
						status: 400,
						message: 'A hex SHA-256 is required'
					});
				}
				yield* sql`
				INSERT INTO blocked_hashes (sha256, reason, added_by)
				VALUES (${normalized}, ${reason}, ${addedBy})
				ON CONFLICT (sha256) DO NOTHING
			`.pipe(storageError('block hash'));
			}
		)
	});
});

export const AdminLive = Layer.effect(Admin, makeAdmin);

export const parseVerdict = (value: string) =>
	isScanVerdict(value) && value !== 'suspicious' ? value : null;
