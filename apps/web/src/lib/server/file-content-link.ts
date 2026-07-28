import type { FileContentLinkResponse, FileSummary } from '@adrive/shared';
import { Effect } from 'effect';
import { AppConfig } from './config';
import { mintPrivateGrant } from './private-grant';
import { Files } from './services/files';

interface ResolvedFileContent {
	readonly file: FileSummary;
}

interface ContentLinkConfig {
	readonly contentOrigin: string;
	readonly passcode: string;
}

export const buildFileContentLink = async (
	config: ContentLinkConfig,
	content: ResolvedFileContent,
	requestedVersion?: number,
	now?: Date
): Promise<FileContentLinkResponse> => {
	const url = new URL(
		`/f/${encodeURIComponent(content.file.id)}`,
		config.contentOrigin
	);
	if (content.file.public) {
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

	const grant = await mintPrivateGrant({
		secret: config.passcode,
		contentOrigin: config.contentOrigin,
		fileId: content.file.id,
		version: content.file.version,
		now
	});
	url.searchParams.set('v', String(content.file.version));
	url.searchParams.set('e', String(grant.expiresAtSeconds));
	url.searchParams.set('g', grant.signature);
	return {
		url: url.href,
		expiresAt: new Date(grant.expiresAtSeconds * 1_000).toISOString(),
		version: content.file.version,
		public: false
	};
};

export const resolveFileContentLink = (id: string, version?: number) =>
	Effect.gen(function* () {
		const config = yield* AppConfig;
		const files = yield* Files;
		const content = yield* files.findContent(id, version);
		return yield* Effect.promise(() =>
			buildFileContentLink(config, content, version)
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
