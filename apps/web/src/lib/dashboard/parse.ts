// Lightweight JSON validators for dashboard API responses.
//
// The server owns real validation with Effect Schema; the client only needs
// to trust the shapes it renders. Using Effect here dragged its runtime into
// the browser bundle (~120 KB gzipped on top of the dashboard), slowing every
// first load and hydration. These parsers mirror the server schemas and throw
// on anything unexpected, keeping the types from @adrive/shared. Like Effect's
// Struct decoders, they require every declared field but ignore extra keys.
import type {
	ApiKey,
	DashboardFile,
	FileContentLinkResponse,
	FileDetailResponse,
	FileListResponse,
	FileMutationResponse,
	FileShare,
	FileShareCreateResponse,
	FileShareListResponse,
	FileSummary,
	FileTagsResponse,
	FileVersion,
	Tag,
	TagResponse,
	UploadResponse
} from '@adrive/shared';

// Response envelopes that @adrive/shared does not name as types.
type ApiKeyListResponse = { readonly keys: ReadonlyArray<ApiKey> };
type ApiKeyCreateResponse = { readonly key: ApiKey; readonly token: string };
type SessionsRevokedResponse = { readonly revoked: number };
type SemanticStatus = {
	readonly enabled: boolean;
	readonly indexedChunks: number;
	readonly dimensions: number;
	readonly model: string;
	readonly costNotice: string;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === 'object' && value !== null && !Array.isArray(value);

const fail = (path: string): never => {
	throw new Error(`The server returned unexpected data at ${path}`);
};

const requireRecord = (
	value: unknown,
	path: string
): Record<string, unknown> => (isRecord(value) ? value : fail(path));

const text = (value: unknown, path: string): string =>
	typeof value === 'string' ? value : fail(path);

const integer = (value: unknown, path: string): number =>
	typeof value === 'number' && Number.isSafeInteger(value) ? value : fail(path);

const flag = (value: unknown, path: string): boolean =>
	typeof value === 'boolean' ? value : fail(path);

const maybeString = (value: unknown, path: string): string | null => {
	if (value === null || typeof value === 'string') return value;
	return fail(path);
};

const literal = <A extends string>(
	value: unknown,
	allowed: ReadonlyArray<A>,
	path: string
): A =>
	typeof value === 'string' && allowed.includes(value as A)
		? (value as A)
		: fail(path);

const list = <A>(
	value: unknown,
	each: (item: unknown, path: string) => A,
	path: string
): ReadonlyArray<A> => {
	if (!Array.isArray(value)) return fail(path);
	return value.map((item: unknown, index: number) =>
		each(item, `${path}[${index}]`)
	);
};

const INDEX_STATES = [
	'pending',
	'running',
	'ready',
	'failed',
	'disabled'
] as const;

const parseFileSummary = (value: unknown, path = 'file'): FileSummary => {
	const record = requireRecord(value, path);
	return {
		id: text(record.id, `${path}.id`),
		displayName: text(record.displayName, `${path}.displayName`),
		contentType: text(record.contentType, `${path}.contentType`),
		kind: literal(record.kind, ['file', 'site'], `${path}.kind`),
		version: integer(record.version, `${path}.version`),
		sizeBytes: integer(record.sizeBytes, `${path}.sizeBytes`),
		public: flag(record.public, `${path}.public`),
		createdAt: text(record.createdAt, `${path}.createdAt`),
		expiresAt: maybeString(record.expiresAt, `${path}.expiresAt`),
		downloadCount: integer(record.downloadCount, `${path}.downloadCount`),
		lastDownloadAt: maybeString(
			record.lastDownloadAt,
			`${path}.lastDownloadAt`
		),
		indexState: literal(record.indexState, INDEX_STATES, `${path}.indexState`),
		indexedVersion:
			record.indexedVersion === null
				? null
				: integer(record.indexedVersion, `${path}.indexedVersion`),
		indexAttempts: integer(record.indexAttempts, `${path}.indexAttempts`),
		indexError: maybeString(record.indexError, `${path}.indexError`)
	};
};

const parseTag = (value: unknown, path = 'tag'): Tag => {
	const record = requireRecord(value, path);
	return {
		id: text(record.id, `${path}.id`),
		name: text(record.name, `${path}.name`),
		normalizedName: text(record.normalizedName, `${path}.normalizedName`),
		color: maybeString(record.color, `${path}.color`),
		fileCount: integer(record.fileCount, `${path}.fileCount`),
		createdAt: text(record.createdAt, `${path}.createdAt`)
	};
};

const parseDashboardFile = (value: unknown, path = 'file'): DashboardFile => {
	const record = requireRecord(value, path);
	return {
		...parseFileSummary(value, path),
		deletedAt: maybeString(record.deletedAt, `${path}.deletedAt`),
		updatedAt: text(record.updatedAt, `${path}.updatedAt`),
		htmlForcedPublic: flag(record.htmlForcedPublic, `${path}.htmlForcedPublic`),
		tags: list(record.tags, (item) => parseTag(item), `${path}.tags`)
	};
};

const parseFileVersion = (value: unknown, path = 'version'): FileVersion => {
	const record = requireRecord(value, path);
	return {
		version: integer(record.version, `${path}.version`),
		sizeBytes: integer(record.sizeBytes, `${path}.sizeBytes`),
		contentType: text(record.contentType, `${path}.contentType`),
		createdAt: text(record.createdAt, `${path}.createdAt`)
	};
};

const parseSemanticStatus = (
	value: unknown,
	path = 'semantic'
): SemanticStatus => {
	const record = requireRecord(value, path);
	return {
		enabled: flag(record.enabled, `${path}.enabled`),
		indexedChunks: integer(record.indexedChunks, `${path}.indexedChunks`),
		dimensions: integer(record.dimensions, `${path}.dimensions`),
		model: text(record.model, `${path}.model`),
		costNotice: text(record.costNotice, `${path}.costNotice`)
	};
};

export const parseFileListResponse = (value: unknown): FileListResponse => {
	const record = requireRecord(value, 'files');
	return {
		files: list(record.files, parseDashboardFile, 'files.files'),
		nextCursor: maybeString(record.nextCursor, 'files.nextCursor'),
		tags: list(record.tags, parseTag, 'files.tags'),
		contentOrigin: text(record.contentOrigin, 'files.contentOrigin'),
		maxUploadBytes: integer(record.maxUploadBytes, 'files.maxUploadBytes'),
		semantic: parseSemanticStatus(record.semantic, 'files.semantic')
	};
};

export const parseFileDetailResponse = (value: unknown): FileDetailResponse => {
	const record = requireRecord(value, 'detail');
	return {
		file: parseDashboardFile(record.file, 'detail.file'),
		versions: list(record.versions, parseFileVersion, 'detail.versions'),
		nextVersionsCursor: maybeString(
			record.nextVersionsCursor,
			'detail.nextVersionsCursor'
		),
		availableTags: list(record.availableTags, parseTag, 'detail.availableTags'),
		contentOrigin: text(record.contentOrigin, 'detail.contentOrigin'),
		maxUploadBytes: integer(record.maxUploadBytes, 'detail.maxUploadBytes'),
		semanticEnabled: flag(record.semanticEnabled, 'detail.semanticEnabled')
	};
};

export const parseFileContentLink = (
	value: unknown
): FileContentLinkResponse => {
	const record = requireRecord(value, 'link');
	return {
		url: text(record.url, 'link.url'),
		expiresAt: maybeString(record.expiresAt, 'link.expiresAt'),
		version: integer(record.version, 'link.version'),
		public: flag(record.public, 'link.public')
	};
};

export const parseFileMutationResponse = (
	value: unknown
): FileMutationResponse => {
	const record = requireRecord(value, 'mutation');
	return {
		file: parseDashboardFile(record.file, 'mutation.file'),
		forcedPublic: flag(record.forcedPublic, 'mutation.forcedPublic')
	};
};

export const parseFileTagsResponse = (value: unknown): FileTagsResponse => {
	const record = requireRecord(value, 'tags');
	return {
		file: parseDashboardFile(record.file, 'tags.file')
	};
};

export const parseUploadResponse = (value: unknown): UploadResponse => {
	const record = requireRecord(value, 'upload');
	return {
		file: parseFileSummary(record.file, 'upload.file'),
		url: text(record.url, 'upload.url'),
		forcedPublic: flag(record.forcedPublic, 'upload.forcedPublic')
	};
};

export const parseTagResponse = (value: unknown): TagResponse => {
	const record = requireRecord(value, 'tag');
	return {
		tag: parseTag(record.tag, 'tag.tag')
	};
};

const maybeStringList = (
	value: unknown,
	path: string
): ReadonlyArray<string> | null =>
	value === null ? null : list(value, text, path);

const parseApiKey = (value: unknown, path = 'key'): ApiKey => {
	const record = requireRecord(value, path);
	return {
		id: text(record.id, `${path}.id`),
		name: text(record.name, `${path}.name`),
		prefix: text(record.prefix, `${path}.prefix`),
		scope: literal(record.scope, ['read-only', 'read-write'], `${path}.scope`),
		createdAt: text(record.createdAt, `${path}.createdAt`),
		expiresAt: maybeString(record.expiresAt, `${path}.expiresAt`),
		lastUsedAt: maybeString(record.lastUsedAt, `${path}.lastUsedAt`),
		revokedAt: maybeString(record.revokedAt, `${path}.revokedAt`),
		allowedTagIds: maybeStringList(record.allowedTagIds, `${path}.allowedTagIds`),
		allowedFileIds: maybeStringList(
			record.allowedFileIds,
			`${path}.allowedFileIds`
		)
	};
};

export const parseApiKeyListResponse = (value: unknown): ApiKeyListResponse => {
	const record = requireRecord(value, 'keys');
	return {
		keys: list(record.keys, parseApiKey, 'keys.keys')
	};
};

export const parseApiKeyCreateResponse = (
	value: unknown
): ApiKeyCreateResponse => {
	const record = requireRecord(value, 'key');
	return {
		key: parseApiKey(record.key, 'key.key'),
		token: text(record.token, 'key.token')
	};
};

export const parseSessionsRevokedResponse = (
	value: unknown
): SessionsRevokedResponse => {
	const record = requireRecord(value, 'sessions');
	return {
		revoked: integer(record.revoked, 'sessions.revoked')
	};
};

const parseFileShare = (value: unknown, path = 'share'): FileShare => {
	const record = requireRecord(value, path);
	return {
		id: text(record.id, `${path}.id`),
		fileId: text(record.fileId, `${path}.fileId`),
		label: maybeString(record.label, `${path}.label`),
		hasPassword: flag(record.hasPassword, `${path}.hasPassword`),
		createdAt: text(record.createdAt, `${path}.createdAt`),
		expiresAt: maybeString(record.expiresAt, `${path}.expiresAt`),
		lastAccessedAt: maybeString(record.lastAccessedAt, `${path}.lastAccessedAt`),
		revokedAt: maybeString(record.revokedAt, `${path}.revokedAt`)
	};
};

export const parseFileShareListResponse = (
	value: unknown
): FileShareListResponse => {
	const record = requireRecord(value, 'shares');
	return {
		shares: list(record.shares, parseFileShare, 'shares.shares'),
		contentOrigin: text(record.contentOrigin, 'shares.contentOrigin')
	};
};

export const parseFileShareCreateResponse = (
	value: unknown
): FileShareCreateResponse => {
	const record = requireRecord(value, 'share');
	return {
		share: parseFileShare(record.share, 'share.share'),
		url: text(record.url, 'share.url')
	};
};
