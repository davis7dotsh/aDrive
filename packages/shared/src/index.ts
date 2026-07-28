import { Schema } from 'effect';

const CONFUSABLE_SEPARATORS =
	/[\u2044\u2215\u2216\u2572\u29f5\u29f8\u29f9\ufe68\uff0f\uff3c]/u;
const CONTROL_OR_BIDI =
	/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/u;
const WINDOWS_DRIVE = /^[a-zA-Z]:/;

export class InvalidSitePath extends Error {
	readonly name = 'InvalidSitePath';
}

export const normalizeSitePath = (value: string) => {
	if (
		value.length === 0 ||
		value.length > 768 ||
		value.startsWith('/') ||
		value.startsWith('\\') ||
		WINDOWS_DRIVE.test(value) ||
		value.includes('\\') ||
		CONFUSABLE_SEPARATORS.test(value) ||
		CONTROL_OR_BIDI.test(value) ||
		value.normalize('NFKC') !== value
	) {
		throw new InvalidSitePath('Site asset path is unsafe');
	}

	const segments = value.split('/');
	if (
		segments.some(
			(segment) =>
				segment.length === 0 ||
				segment.length > 255 ||
				segment === '.' ||
				segment === '..'
		)
	) {
		throw new InvalidSitePath('Site asset path is unsafe');
	}

	return segments.join('/');
};

export const sitePathCandidates = (value: string) => {
	if (value === '') return ['index.html'];
	if (value.endsWith('/')) {
		const directory = normalizeSitePath(value.slice(0, -1));
		return [`${directory}/index.html`];
	}
	const exact = normalizeSitePath(value);
	return [exact, `${exact}/index.html`];
};

export const FileSummarySchema = Schema.Struct({
	id: Schema.String,
	displayName: Schema.String,
	contentType: Schema.String,
	kind: Schema.Literals(['file', 'site']),
	version: Schema.Int,
	sizeBytes: Schema.Int,
	public: Schema.Boolean,
	createdAt: Schema.String,
	expiresAt: Schema.NullOr(Schema.String),
	downloadCount: Schema.Int,
	lastDownloadAt: Schema.NullOr(Schema.String)
});

export type FileSummary = typeof FileSummarySchema.Type;

export const TagSchema = Schema.Struct({
	id: Schema.String,
	name: Schema.String,
	normalizedName: Schema.String,
	color: Schema.NullOr(Schema.String),
	fileCount: Schema.Int,
	createdAt: Schema.String
});

export type Tag = typeof TagSchema.Type;

export const DashboardFileSchema = Schema.Struct({
	id: Schema.String,
	displayName: Schema.String,
	contentType: Schema.String,
	kind: Schema.Literals(['file', 'site']),
	version: Schema.Int,
	sizeBytes: Schema.Int,
	public: Schema.Boolean,
	htmlForcedPublic: Schema.Boolean,
	createdAt: Schema.String,
	updatedAt: Schema.String,
	deletedAt: Schema.NullOr(Schema.String),
	expiresAt: Schema.NullOr(Schema.String),
	downloadCount: Schema.Int,
	lastDownloadAt: Schema.NullOr(Schema.String),
	tags: Schema.Array(TagSchema)
});

export type DashboardFile = typeof DashboardFileSchema.Type;

export const FileVersionSchema = Schema.Struct({
	version: Schema.Int,
	sizeBytes: Schema.Int,
	contentType: Schema.String,
	createdAt: Schema.String
});

export type FileVersion = typeof FileVersionSchema.Type;

export const FileDetailSchema = Schema.Struct({
	file: DashboardFileSchema,
	versions: Schema.Array(FileVersionSchema)
});

export type FileDetail = typeof FileDetailSchema.Type;

export const FileListResponseSchema = Schema.Struct({
	files: Schema.Array(DashboardFileSchema),
	tags: Schema.Array(TagSchema),
	contentOrigin: Schema.String,
	maxUploadBytes: Schema.Int
});

export type FileListResponse = typeof FileListResponseSchema.Type;

export const FileDetailResponseSchema = Schema.Struct({
	file: DashboardFileSchema,
	versions: Schema.Array(FileVersionSchema),
	availableTags: Schema.Array(TagSchema),
	contentOrigin: Schema.String,
	maxUploadBytes: Schema.Int
});

export type FileDetailResponse = typeof FileDetailResponseSchema.Type;

export const FileMutationSchema = Schema.Union([
	Schema.Struct({
		action: Schema.Literal('visibility'),
		public: Schema.Boolean
	}),
	Schema.Struct({
		action: Schema.Literal('trash')
	}),
	Schema.Struct({
		action: Schema.Literal('restore')
	}),
	Schema.Struct({
		action: Schema.Literal('expiration'),
		expiresAt: Schema.NullOr(Schema.String)
	})
]);

export type FileMutation = typeof FileMutationSchema.Type;

export const FileMutationResponseSchema = Schema.Struct({
	file: DashboardFileSchema,
	forcedPublic: Schema.Boolean
});

export type FileMutationResponse = typeof FileMutationResponseSchema.Type;

export const TagCreateSchema = Schema.Struct({
	name: Schema.String,
	color: Schema.optionalKey(Schema.NullOr(Schema.String))
});

export type TagCreate = typeof TagCreateSchema.Type;

export const TagUpdateSchema = Schema.Struct({
	name: Schema.optionalKey(Schema.String),
	color: Schema.optionalKey(Schema.NullOr(Schema.String))
});

export type TagUpdate = typeof TagUpdateSchema.Type;

export const TagListResponseSchema = Schema.Struct({
	tags: Schema.Array(TagSchema)
});

export type TagListResponse = typeof TagListResponseSchema.Type;

export const TagResponseSchema = Schema.Struct({
	tag: TagSchema
});

export type TagResponse = typeof TagResponseSchema.Type;

export const FileTagsUpdateSchema = Schema.Struct({
	names: Schema.Array(Schema.String)
});

export type FileTagsUpdate = typeof FileTagsUpdateSchema.Type;

export const FileTagsResponseSchema = Schema.Struct({
	file: DashboardFileSchema
});

export type FileTagsResponse = typeof FileTagsResponseSchema.Type;

export const UploadResponseSchema = Schema.Struct({
	file: FileSummarySchema,
	url: Schema.String,
	forcedPublic: Schema.Boolean
});

export type UploadResponse = typeof UploadResponseSchema.Type;

export const SiteManifestAssetSchema = Schema.Struct({
	path: Schema.String,
	sizeBytes: Schema.Int,
	contentType: Schema.String
});

export type SiteManifestAsset = typeof SiteManifestAssetSchema.Type;

export const SiteSessionCreateSchema = Schema.Struct({
	displayName: Schema.String,
	fileId: Schema.optionalKey(Schema.String),
	assets: Schema.Array(SiteManifestAssetSchema)
});

export type SiteSessionCreate = typeof SiteSessionCreateSchema.Type;

export const SiteSessionResponseSchema = Schema.Struct({
	sessionId: Schema.String,
	fileId: Schema.String,
	version: Schema.Int,
	expiresAt: Schema.String
});

export type SiteSessionResponse = typeof SiteSessionResponseSchema.Type;

export const SiteAssetResponseSchema = Schema.Struct({
	path: Schema.String,
	sizeBytes: Schema.Int,
	contentType: Schema.String
});

export type SiteAssetResponse = typeof SiteAssetResponseSchema.Type;

export const SiteCommitResponseSchema = Schema.Struct({
	file: FileSummarySchema,
	url: Schema.String,
	assetCount: Schema.Int,
	cleanupPending: Schema.Boolean
});

export type SiteCommitResponse = typeof SiteCommitResponseSchema.Type;

export const AuthCheckResponseSchema = Schema.Struct({
	ok: Schema.Literal(true)
});

export const PasscodeLoginSchema = Schema.Struct({
	passcode: Schema.String
});

export const ApiKeyCreateSchema = Schema.Struct({
	name: Schema.String
});

export const ApiKeySchema = Schema.Struct({
	id: Schema.String,
	name: Schema.String,
	prefix: Schema.String,
	createdAt: Schema.String,
	lastUsedAt: Schema.NullOr(Schema.String),
	revokedAt: Schema.NullOr(Schema.String)
});

export type ApiKey = typeof ApiKeySchema.Type;

export const ApiKeyListResponseSchema = Schema.Struct({
	keys: Schema.Array(ApiKeySchema)
});

export const ApiKeyCreateResponseSchema = Schema.Struct({
	key: ApiKeySchema,
	token: Schema.String
});

export const DeviceAuthorizationCreateSchema = Schema.Struct({
	name: Schema.String
});

export const DeviceAuthorizationResponseSchema = Schema.Struct({
	deviceCode: Schema.String,
	userCode: Schema.String,
	verificationUri: Schema.String,
	verificationUriComplete: Schema.String,
	expiresIn: Schema.Int,
	interval: Schema.Int
});

export const DeviceApprovalSchema = Schema.Struct({
	userCode: Schema.String
});

export const DeviceTokenRequestSchema = Schema.Struct({
	deviceCode: Schema.String
});

export const DeviceTokenResponseSchema = Schema.Struct({
	apiKey: Schema.String
});

export const DevicePendingResponseSchema = Schema.Struct({
	status: Schema.Literals(['authorization_pending', 'slow_down'])
});

export const ErrorResponseSchema = Schema.Struct({
	error: Schema.String
});

export const API_KEY_PATTERN = /^adr_([A-Za-z0-9]{8})_([A-Za-z0-9_-]{24,})$/;
