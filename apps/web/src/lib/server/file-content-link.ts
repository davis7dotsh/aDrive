import type { FileContentLinkResponse, FileSummary } from '@adrive/shared';
import { Effect } from 'effect';
import { AppConfig } from './config';
import { InvalidRequest } from './errors';
import type { PrivateGrant } from './private-grant';
import { Files } from './services/files';
import { GrantSecrets } from './services/grant-secrets';

interface ResolvedFileContent {
	readonly file: FileSummary;
}

interface ContentLinkConfig {
	readonly contentOrigin: string;
}

export const buildFileContentLink = async (
	config: ContentLinkConfig,
	content: ResolvedFileContent,
	requestedVersion?: number,
	privateGrant?: PrivateGrant,
	requireGrant = false
): Promise<FileContentLinkResponse> => {
	const url = new URL(
		`/f/${encodeURIComponent(content.file.id)}`,
		config.contentOrigin
	);
	if (content.file.public && !requireGrant) {
		if (requestedVersion !== undefined) {
			url.searchParams.set('v', String(content.file.version));
		}
		return {
			url: url.href,
			expiresAt: null,
			version: content.file.version,
			public: true
		};
	}

	if (!privateGrant) throw new Error('A private content grant is required');
	url.searchParams.set('v', String(content.file.version));
	url.searchParams.set('e', String(privateGrant.expiresAtSeconds));
	url.searchParams.set('g', privateGrant.signature);
	return {
		url: url.href,
		expiresAt: new Date(privateGrant.expiresAtSeconds * 1_000).toISOString(),
		version: content.file.version,
		public: false
	};
};

export const resolveFileContentLink = (
	id: string,
	version?: number,
	includeUnavailable = false,
	requireGrant = false
) =>
	Effect.gen(function* () {
		const config = yield* AppConfig;
		const files = yield* Files;
		const grantSecrets = yield* GrantSecrets;
		if (includeUnavailable) {
			const detail = yield* files.detail(id);
			if (detail.file.kind === 'site') {
				if (version !== undefined && version !== detail.file.version) {
					return yield* new InvalidRequest({
						status: 400,
						message: 'Only the current site version can be previewed'
					});
				}
				const grant = yield* grantSecrets.mint({
					contentOrigin: config.contentOrigin,
					fileId: detail.file.id,
					version: detail.file.version
				});
				const url = new URL(
					`/s/${encodeURIComponent(detail.file.id)}/@grant/${detail.file.version}/${grant.expiresAtSeconds}/${grant.signature}/`,
					config.contentOrigin
				);
				return {
					url: url.href,
					expiresAt: new Date(grant.expiresAtSeconds * 1_000).toISOString(),
					version: detail.file.version,
					public: false
				};
			}
		}
		const content = yield* files.findContent(id, version, includeUnavailable);
		const grant =
			content.file.public && !includeUnavailable && !requireGrant
				? undefined
				: yield* grantSecrets.mint({
						contentOrigin: config.contentOrigin,
						fileId: content.file.id,
						version: content.file.version
					});
		return yield* Effect.promise(() =>
			buildFileContentLink(
				config,
				content,
				version,
				grant,
				includeUnavailable || requireGrant
			)
		);
	});

export const contentLinkJsonResponse = (link: FileContentLinkResponse) =>
	Response.json(link, {
		headers: {
			'Cache-Control': 'private, no-store'
		}
	});

export const contentLinkRedirectResponse = (link: FileContentLinkResponse) =>
	new Response(null, {
		status: 307,
		headers: {
			'Cache-Control': 'private, no-store',
			Location: link.url
		}
	});
