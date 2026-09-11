import { Effect } from 'effect';
import { contentVersionAccess } from '../../content-version-access';
import { InvalidRequest, NotFound, StorageError } from '../../errors';
import {
	dashboardFileColumns,
	decodeDashboardRows,
	toDashboardFile
} from '../../file-rows';
import {
	decodeListCursor,
	encodeListCursor,
	type ListCursor
} from '../../list-cursor';
import { tenantOrgId } from '../current-org';
import type { FileInternals } from './internals';
import type { FilesShape } from './types';
import { decodeContentRows, decodeVersionRows, toVersion } from './types';

export const queryOps = (
	internals: FileInternals
): Pick<FilesShape, 'list' | 'detail' | 'findContent'> => {
	const { sql, org, findDashboardFile } = internals;
	return {
		list: Effect.fn('Files.list')(function* (trashed, page) {
			const now = new Date().toISOString();
			const limit = page?.limit ?? 200;
			const cursor = yield* Effect.try({
				try: () => decodeListCursor(page?.cursor ?? null),
				catch: (cause) =>
					cause instanceof InvalidRequest
						? cause
						: new InvalidRequest({ status: 400, message: 'Cursor is invalid' })
			});
			const sortColumn = sql.literal(trashed ? 'f.deleted_at' : 'f.updated_at');
			// Keyset pagination over (sort column, id); one extra row tells us
			// whether another page exists without a second query.
			const rows = yield* sql`
				SELECT ${sql.literal(dashboardFileColumns)}
				FROM files f
				WHERE ${sql.and([
					sql`f.org_id = ${org.id}`,
					trashed
						? sql`f.deleted_at IS NOT NULL AND (f.purge_at IS NULL OR f.purge_at > ${now})`
						: sql`f.deleted_at IS NULL AND (f.expires_at IS NULL OR f.expires_at > ${now})`,
					...(cursor
						? [
								sql`(${sortColumn} < ${cursor.k} OR (${sortColumn} = ${cursor.k} AND f.id > ${cursor.id}))`
							]
						: [])
				])}
				ORDER BY ${sortColumn} DESC, f.id
				LIMIT ${limit + 1}`.pipe(
				Effect.mapError(
					(cause) =>
						new StorageError({
							operation: trashed ? 'list trashed files' : 'list active files',
							cause
						})
				)
			);
			const decoded = decodeDashboardRows(rows);
			const pageRows = decoded.slice(0, limit);
			const files = pageRows.map(toDashboardFile);
			const last = pageRows[pageRows.length - 1];
			const nextCursor =
				decoded.length > limit && last
					? encodeListCursor({
							k: (trashed ? last.deleted_at : last.updated_at) ?? '',
							id: last.id
						} satisfies ListCursor)
					: null;
			return { files, nextCursor };
		}),
		detail: Effect.fn('Files.detail')(function* (id, versionPage) {
			const file = yield* findDashboardFile(id);
			const limit = versionPage?.limit ?? 50;
			const cursor = yield* Effect.try({
				try: () => decodeListCursor(versionPage?.cursor ?? null),
				catch: (cause) =>
					cause instanceof InvalidRequest
						? cause
						: new InvalidRequest({ status: 400, message: 'Cursor is invalid' })
			});
			const beforeVersion = cursor ? Number(cursor.k) : null;
			if (beforeVersion !== null && !Number.isSafeInteger(beforeVersion)) {
				return yield* new InvalidRequest({
					status: 400,
					message: 'Cursor is invalid'
				});
			}
			const rows = yield* sql`
				SELECT version, size_bytes, content_type, created_at
				FROM file_versions
				WHERE ${sql.and([
					sql`file_id = ${id}`,
					sql`org_id = ${org.id}`,
					...(beforeVersion !== null ? [sql`version < ${beforeVersion}`] : [])
				])}
				ORDER BY version DESC
				LIMIT ${limit + 1}`.pipe(
				Effect.mapError(
					(cause) =>
						new StorageError({ operation: 'list file versions', cause })
				)
			);
			const decoded = decodeVersionRows(rows);
			const pageRows = decoded.slice(0, limit);
			const lastVersion = pageRows[pageRows.length - 1];
			return {
				file,
				versions: pageRows.map(toVersion),
				nextVersionsCursor:
					decoded.length > limit && lastVersion
						? encodeListCursor({
								k: String(lastVersion.version),
								id
							} satisfies ListCursor)
						: null
			};
		}),
		findContent: Effect.fn('Files.findContent')(function* (
			id,
			version,
			includeUnavailable = false,
			includeSites = false
		) {
			if (
				version !== undefined &&
				(!Number.isSafeInteger(version) || version < 1)
			) {
				return yield* new InvalidRequest({
					status: 400,
					message: 'Version is invalid'
				});
			}
			const now = new Date().toISOString();
			// Content routes run without a tenant and resolve the org from the
			// file row (ids are globally unique); dashboard callers are pinned
			// to their own org so a foreign id is a plain 404.
			const orgId = tenantOrgId(org);
			const orgFilter = sql`(${orgId}::text IS NULL OR f.org_id = ${orgId})`;
			const available = sql`(
				${includeUnavailable}::boolean
				OR (
					f.deleted_at IS NULL
					AND (f.expires_at IS NULL OR f.expires_at > ${now})
				)
			)`;
			// A quarantined file is gone from every content route, grant or not.
			const siteFilter = sql`(${includeSites}::boolean OR f.is_site = false)
					AND f.quarantined = false`;
			const versionAccess = contentVersionAccess(sql);
			const rows =
				version === undefined
					? yield* sql`
							SELECT
								f.id, f.org_id, f.display_name, v.content_type, v.version,
									v.size_bytes, ${versionAccess.isPublic} AS is_public, f.is_site, v.r2_key,
								v.thumbnail_r2_key, v.created_at
							FROM files f
							JOIN file_versions v
									ON v.file_id = f.id AND v.version = f.current_version
								${versionAccess.review}
							WHERE f.id = ${id} AND ${orgFilter} AND ${available}
									AND ${siteFilter} AND ${versionAccess.allowed}
							LIMIT 1
						`.pipe(
							Effect.mapError(
								(cause) => new StorageError({ operation: 'find file', cause })
							)
						)
					: yield* sql`
							SELECT
								f.id, f.org_id, f.display_name, v.content_type, v.version,
									v.size_bytes, ${versionAccess.isPublic} AS is_public, f.is_site, v.r2_key,
								v.thumbnail_r2_key, v.created_at
							FROM files f
								JOIN file_versions v ON v.file_id = f.id
								${versionAccess.review}
							WHERE f.id = ${id} AND v.version = ${version} AND ${orgFilter}
									AND ${available} AND ${siteFilter} AND ${versionAccess.allowed}
								AND (f.is_site = false OR v.version = f.current_version)
							LIMIT 1
						`.pipe(
							Effect.mapError(
								(cause) =>
									new StorageError({ operation: 'find file version', cause })
							)
						);
			const row = decodeContentRows(rows)[0];
			if (!row) return yield* new NotFound({ id });
			return {
				file: {
					id: row.id,
					displayName: row.display_name,
					contentType: row.content_type,
					kind: row.is_site ? 'site' : 'file',
					version: row.version,
					sizeBytes: row.size_bytes,
					public: row.is_public,
					createdAt: row.created_at,
					expiresAt: null,
					downloadCount: 0,
					lastDownloadAt: null,
					indexState: 'disabled',
					indexedVersion: null,
					indexAttempts: 0,
					indexError: null
				},
				orgId: row.org_id,
				r2Key: row.r2_key,
				thumbnailR2Key: row.thumbnail_r2_key
			};
		})
	} satisfies Pick<FilesShape, 'list' | 'detail' | 'findContent'>;
};
