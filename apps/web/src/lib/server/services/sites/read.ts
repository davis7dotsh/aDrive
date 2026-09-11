import { sitePathCandidates } from '@adrive/shared';
import { Effect } from 'effect';
import { InvalidRequest, NotFound } from '../../errors';
import { tenantOrgId } from '../current-org';
import type { SiteInternals } from './internals';
import { SiteAssetRow, type SitesShape } from './types';

export const readOps = (
	internals: SiteInternals
): Pick<SitesShape, 'findAsset'> => {
	const { all, sql, org } = internals;

	return {
		findAsset: Effect.fn('Sites.findAsset')(function* (
			fileId: string,
			requestPath: string,
			options: {
				readonly includeUnavailable?: boolean;
				readonly version?: number;
			} = {}
		) {
			const candidates = yield* Effect.try({
				try: () => sitePathCandidates(requestPath),
				catch: () =>
					new InvalidRequest({
						status: 400,
						message: 'Site asset path is unsafe'
					})
			});
			// Only signed owner routes set this; the caller verifies the bound
			// grant before serving bytes. Held sites remain private anonymously.
			const includeUnavailable = options.includeUnavailable === true;
			const pinVersion = options.version !== undefined;
			// Content requests carry the org their host names, so a site id
			// from another org is a 404 on this host.
			const orgId = tenantOrgId(org);
			const rows = yield* all(
				sql`
					SELECT f.org_id, a.path, a.r2_key, a.content_type, a.size_bytes
					FROM files f
					JOIN site_assets a
						ON a.file_id = f.id AND a.version = f.current_version
					WHERE f.id = ${fileId} AND f.is_site = true
						AND (f.public = true OR ${includeUnavailable}::boolean)
						AND f.quarantined = false
						AND (${orgId}::text IS NULL OR f.org_id = ${orgId})
						AND (
							${includeUnavailable}::boolean
							OR (
								f.deleted_at IS NULL
								AND (f.expires_at IS NULL OR f.expires_at > ${new Date().toISOString()})
							)
						)
						AND (${pinVersion}::boolean = false OR a.version = ${options.version ?? 0})
						AND a.path = ANY(${candidates}::text[])`,
				SiteAssetRow,
				'find site asset'
			);
			const byPath = new Map(rows.map((row) => [row.path, row]));
			const asset = candidates.flatMap((path) => {
				const value = byPath.get(path);
				return value ? [value] : [];
			})[0];
			if (!asset) return yield* new NotFound({ id: fileId });
			return {
				orgId: asset.org_id,
				path: asset.path,
				r2Key: asset.r2_key,
				contentType: asset.content_type,
				sizeBytes: asset.size_bytes
			};
		})
	};
};
