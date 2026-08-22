import { FileListResponseSchema } from '@adrive/shared';
import type { FileListResponse } from '@adrive/shared';
import { Effect, Schema } from 'effect';
import {
	supportsDashboardThumbnail,
	supportsRenderedDashboardThumbnail
} from '$lib/file-thumbnail';
import { listingMode } from '$lib/listing';
import { AppConfig } from '$lib/server/config';
import { runWorkerProgram } from '$lib/server/edge';
import { GrantSecrets } from '$lib/server/services/grant-secrets';
import type { PageServerLoad } from './$types';

// Preload the first-viewport public thumbnails so the grid's first images are
// fetched in parallel with the page's JavaScript instead of waiting for the
// IntersectionObserver to see them after hydration. Served URLs are immutable
// per (id, version), so the browser caches them across visits.
const THUMBNAIL_PRELOAD_LIMIT = 12;

const eligibleForThumbnailPreload = (file: FileListResponse['files'][number]) =>
	file.public &&
	file.deletedAt === null &&
	file.expiresAt === null &&
	(supportsDashboardThumbnail(file.contentType) ||
		supportsRenderedDashboardThumbnail(file.kind, file.contentType));

const thumbnailPreloadTargets = (list: FileListResponse) => {
	if (!list.contentOrigin) return [];
	const targets: Array<{ id: string; version: number }> = [];
	for (const file of list.files) {
		if (targets.length >= THUMBNAIL_PRELOAD_LIMIT) break;
		if (eligibleForThumbnailPreload(file)) {
			targets.push({ id: file.id, version: file.version });
		}
	}
	return targets;
};

const preloadUrls = (
	list: FileListResponse,
	grants: ReadonlyArray<{ expires: string; signature: string } | undefined>
) =>
	thumbnailPreloadTargets(list).map((target, index) => {
		const url = new URL(
			`/t/${encodeURIComponent(target.id)}/${target.version}/grid.webp`,
			list.contentOrigin
		);
		const grant = grants[index];
		if (grant) {
			url.searchParams.set('e', grant.expires);
			url.searchParams.set('g', grant.signature);
		}
		return url.href;
	});

// Thumbnail generation is gated behind a signed grant (billing protection),
// so a bare first request for a not-yet-generated public thumbnail 404s until
// the client's fallback mints one. Mint grants server-side here so the very
// first dashboard view generates+warms the first viewport immediately; any
// failure falls back to bare URLs, which still self-heal after generation.
const grantedThumbnailPreloads = async (
	env: Env | undefined,
	list: FileListResponse
) => {
	const plain = preloadUrls(list, []);
	if (plain.length === 0 || env === undefined) return plain;
	try {
		const minted = await runWorkerProgram(
			env,
			Effect.all(
				thumbnailPreloadTargets(list).map(({ id, version }) =>
					Effect.gen(function* () {
						const config = yield* AppConfig;
						const secrets = yield* GrantSecrets;
						return yield* secrets.mint({
							contentOrigin: config.contentOrigin,
							fileId: id,
							version
						});
					})
				),
				{ concurrency: 'unbounded' }
			)
		);
		return preloadUrls(
			list,
			minted.map((grant) => ({
				expires: String(grant.expiresAtSeconds),
				signature: grant.signature
			}))
		);
	} catch {
		return plain;
	}
};

const readError = async (response: Response) => {
	try {
		const body: unknown = await response.json();
		if (
			typeof body === 'object' &&
			body !== null &&
			'message' in body &&
			typeof body.message === 'string'
		) {
			return body.message;
		}
	} catch {
		// The status fallback below is enough for non-JSON failures.
	}
	return `Could not load files (${response.status})`;
};

const tagIds = (url: URL) => {
	const value = url.searchParams.get('tags');
	if (!value) return [];
	try {
		const parsed: unknown = JSON.parse(value);
		return Array.isArray(parsed)
			? parsed.filter((tag): tag is string => typeof tag === 'string')
			: [];
	} catch {
		return [];
	}
};

export const load: PageServerLoad = async ({
	depends,
	fetch,
	platform,
	url
}) => {
	depends('adrive:files');
	const mode = listingMode(
		url.searchParams.get('view'),
		url.searchParams.get('q') ?? '',
		tagIds(url)
	);
	const params = new URLSearchParams();
	if (mode.kind === 'list' && mode.trashed) {
		params.set('trashed', 'true');
	} else if (mode.kind === 'search') {
		params.set('q', mode.query);
		for (const tag of mode.tags.slice(0, 20)) {
			params.append('tag', tag);
		}
	}
	const path =
		mode.kind === 'list'
			? `/api/files${params.size > 0 ? `?${params}` : ''}`
			: `/api/search?${params}`;
	let response: Response;
	try {
		response = await fetch(path);
	} catch {
		return {
			initialList: null,
			initialError: 'Could not load files',
			thumbnailPreloads: []
		};
	}
	if (response.status === 401) {
		return {
			initialList: null,
			initialError: '',
			thumbnailPreloads: []
		};
	}
	if (!response.ok) {
		return {
			initialList: null,
			initialError: await readError(response),
			thumbnailPreloads: []
		};
	}
	try {
		const initialList = await Schema.decodeUnknownPromise(
			FileListResponseSchema
		)(await response.json());
		return {
			initialList,
			initialError: '',
			thumbnailPreloads: await grantedThumbnailPreloads(
				platform?.env,
				initialList
			)
		};
	} catch {
		return {
			initialList: null,
			initialError: 'The server returned invalid file data',
			thumbnailPreloads: []
		};
	}
};
