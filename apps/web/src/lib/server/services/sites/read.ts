import { sitePathCandidates } from '@adrive/shared';
import { Effect } from 'effect';
import { InvalidRequest, NotFound } from '../../errors';
import type { SiteInternals } from './internals';
import { SiteAssetRow } from './types';

export const readOps = (internals: SiteInternals) => {
	const { all, stagedAssets, db } = internals;

	return {
		stagedAssets,
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
			const rows = yield* all(
				db
					.prepare(
						`SELECT a.path, a.r2_key, a.content_type, a.size_bytes
						FROM files f
						JOIN site_assets a
							ON a.file_id = f.id AND a.version = f.current_version
						WHERE f.id = ? AND f.is_site = 1 AND f.public = 1
							AND a.version = f.current_version
							AND (
								? = 1
								OR (
									f.deleted_at IS NULL
									AND (f.expires_at IS NULL OR f.expires_at > ?)
								)
							)
							AND (? = 0 OR a.version = ?)
							AND a.path IN (${candidates.map(() => '?').join(', ')})`
					)
					.bind(
						fileId,
						options.includeUnavailable ? 1 : 0,
						new Date().toISOString(),
						options.version === undefined ? 0 : 1,
						options.version ?? 0,
						...candidates
					),
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
				path: asset.path,
				r2Key: asset.r2_key,
				contentType: asset.content_type,
				sizeBytes: asset.size_bytes
			};
		})
	};
};
