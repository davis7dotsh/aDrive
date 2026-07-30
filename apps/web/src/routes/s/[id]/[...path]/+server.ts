import type { RequestHandler } from './$types';
import { Effect } from 'effect';
import { shouldCountDownload } from '$lib/server/auth-policy';
import { contentSecurityPolicy } from '$lib/server/content-headers';
import { AppConfig } from '$lib/server/config';
import { runEdge } from '$lib/server/edge';
import { NotFound } from '$lib/server/errors';
import { isSiteVersionRequestServable } from '$lib/server/site-policy';
import { Blobs } from '$lib/server/services/blobs';
import { Files } from '$lib/server/services/files';
import { Sites } from '$lib/server/services/sites';
import { GrantSecrets } from '$lib/server/services/grant-secrets';

export const trailingSlash = 'ignore';

const siteGrant = (path: string) => {
	const [marker, versionValue, expiresValue, signature, ...assetPath] =
		path.split('/');
	if (marker !== '@grant') return null;
	const version = Number(versionValue);
	const expiresAtSeconds = Number(expiresValue);
	if (
		!Number.isSafeInteger(version) ||
		version < 1 ||
		!Number.isSafeInteger(expiresAtSeconds) ||
		expiresAtSeconds < 1 ||
		!/^[A-Za-z0-9_-]{43}$/.test(signature ?? '')
	) {
		return false;
	}
	return {
		version,
		expiresAtSeconds,
		signature: signature ?? '',
		assetPath: assetPath.join('/')
	};
};

export const GET: RequestHandler = ({ params, request, url }) =>
	runEdge(
		Effect.gen(function* () {
			const grant = siteGrant(params.path ?? '');
			if (grant === false) return yield* new NotFound({ id: params.id });
			const hasGrant = grant !== null;
			if (
				!hasGrant &&
				!isSiteVersionRequestServable(url.searchParams.get('v'))
			) {
				return yield* new NotFound({ id: params.id });
			}
			const sites = yield* Sites;
			const blobs = yield* Blobs;
			const files = yield* Files;
			const config = yield* AppConfig;
			if (grant) {
				const grantSecrets = yield* GrantSecrets;
				const granted = yield* grantSecrets.verify({
					contentOrigin: config.contentOrigin,
					requestOrigin: url.origin,
					fileId: params.id,
					version: grant.version,
					expiresAtSeconds: grant.expiresAtSeconds,
					signature: grant.signature
				});
				if (!granted) return yield* new NotFound({ id: params.id });
			}
			const asset = yield* sites.findAsset(
				params.id,
				grant ? grant.assetPath : (params.path ?? ''),
				{
					includeUnavailable: hasGrant,
					version: grant?.version
				}
			);
			const object = yield* blobs.get(asset.r2Key);
			if (
				asset.contentType === 'text/html' &&
				shouldCountDownload(request.headers.get('range'))
			) {
				yield* files.recordDownload(params.id);
			}
			return new Response(object.body, {
				headers: {
					'Cache-Control': hasGrant
						? 'private, no-store'
						: 'public, max-age=0, must-revalidate',
					'Content-Length': String(object.size),
					'Content-Security-Policy': contentSecurityPolicy(
						asset.contentType,
						config.dashboardOrigin
					),
					'Content-Type': asset.contentType,
					ETag: object.httpEtag,
					'Referrer-Policy': 'no-referrer',
					'X-Content-Type-Options': 'nosniff'
				}
			});
		})
	);
