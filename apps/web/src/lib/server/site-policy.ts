import {
	InvalidSitePath,
	normalizeSitePath,
	type SiteManifestAsset
} from '@adrive/shared';
import mime from 'mime';
import { InvalidRequest } from './errors';
import { cleanContentType, cleanFileName } from './file-policy';

export const MAX_SITE_ASSETS = 500;
export const SITE_SESSION_TTL_MS = 60 * 60 * 1000;

export interface PreparedSiteAsset extends SiteManifestAsset {
	readonly path: string;
	readonly contentType: string;
}

export const inferSiteContentType = (path: string, supplied: string) =>
	mime.getType(path) ?? cleanContentType(supplied);

export const prepareSiteManifest = (
	input: {
		readonly displayName: string;
		readonly assets: ReadonlyArray<SiteManifestAsset>;
	},
	maxUploadBytes: number
) => {
	const displayName = cleanFileName(input.displayName);
	if (input.assets.length === 0 || input.assets.length > MAX_SITE_ASSETS) {
		throw new InvalidRequest({
			status: 400,
			message: `A site must contain between 1 and ${MAX_SITE_ASSETS} assets`
		});
	}

	const paths = new Set<string>();
	const assets: Array<PreparedSiteAsset> = [];
	for (const asset of input.assets) {
		let path: string;
		try {
			path = normalizeSitePath(asset.path);
		} catch (cause) {
			if (cause instanceof InvalidSitePath) {
				throw new InvalidRequest({
					status: 400,
					message: `Site asset path is unsafe: ${asset.path}`
				});
			}
			throw cause;
		}
		if (paths.has(path)) {
			throw new InvalidRequest({
				status: 400,
				message: `Site manifest contains a duplicate path: ${path}`
			});
		}
		if (
			!Number.isSafeInteger(asset.sizeBytes) ||
			asset.sizeBytes < 0 ||
			asset.sizeBytes > maxUploadBytes
		) {
			throw new InvalidRequest({
				status: asset.sizeBytes > maxUploadBytes ? 413 : 400,
				message: `Site asset has an invalid size: ${path}`
			});
		}
		paths.add(path);
		assets.push({
			path,
			sizeBytes: asset.sizeBytes,
			contentType: inferSiteContentType(path, asset.contentType)
		});
	}

	if (!paths.has('index.html')) {
		throw new InvalidRequest({
			status: 400,
			message: 'A site must contain a root index.html'
		});
	}

	return { displayName, assets };
};

export const assertOpenSiteSession = (
	session: { readonly status: string; readonly expiresAt: string },
	now: Date
) => {
	if (session.status !== 'open') {
		throw new InvalidRequest({
			status: 409,
			message: 'Site upload session is no longer open'
		});
	}
	if (new Date(session.expiresAt).getTime() <= now.getTime()) {
		throw new InvalidRequest({
			status: 409,
			message: 'Site upload session has expired'
		});
	}
};

export const validateCommittedAssets = (
	assets: ReadonlyArray<{
		readonly path: string;
		readonly expectedSizeBytes: number;
		readonly storedSizeBytes: number | null;
		readonly r2Key: string | null;
	}>
) => {
	const incomplete = assets.find(
		(asset) =>
			asset.r2Key === null ||
			asset.storedSizeBytes === null ||
			asset.storedSizeBytes !== asset.expectedSizeBytes
	);
	if (incomplete) {
		throw new InvalidRequest({
			status: 409,
			message: `Site asset is missing or incomplete: ${incomplete.path}`
		});
	}
	return assets.reduce((total, asset) => {
		const next = total + asset.expectedSizeBytes;
		if (!Number.isSafeInteger(next)) {
			throw new InvalidRequest({
				status: 400,
				message: 'Site asset sizes exceed the supported total'
			});
		}
		return next;
	}, 0);
};

export const isSiteVersionRequestServable = (requestedVersion: string | null) =>
	requestedVersion === null;

export const siteCleanupDisposition = (
	keys: ReadonlyArray<string>,
	deleteSucceeded: boolean
) => ({
	deleteFromQueue: deleteSucceeded ? keys : [],
	remainsPending: !deleteSucceeded && keys.length > 0
});
