import { Schema } from 'effect';

export const FileSummarySchema = Schema.Struct({
	id: Schema.String,
	displayName: Schema.String,
	contentType: Schema.String,
	version: Schema.Int,
	sizeBytes: Schema.Int,
	public: Schema.Boolean,
	createdAt: Schema.String
});

export type FileSummary = typeof FileSummarySchema.Type;

export const DashboardFileSchema = Schema.Struct({
	id: Schema.String,
	displayName: Schema.String,
	contentType: Schema.String,
	version: Schema.Int,
	sizeBytes: Schema.Int,
	public: Schema.Boolean,
	htmlForcedPublic: Schema.Boolean,
	createdAt: Schema.String,
	updatedAt: Schema.String,
	deletedAt: Schema.NullOr(Schema.String)
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
	contentOrigin: Schema.String,
	maxUploadBytes: Schema.Int
});

export type FileListResponse = typeof FileListResponseSchema.Type;

export const FileDetailResponseSchema = Schema.Struct({
	file: DashboardFileSchema,
	versions: Schema.Array(FileVersionSchema),
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
	})
]);

export type FileMutation = typeof FileMutationSchema.Type;

export const FileMutationResponseSchema = Schema.Struct({
	file: DashboardFileSchema,
	forcedPublic: Schema.Boolean
});

export type FileMutationResponse = typeof FileMutationResponseSchema.Type;

export const UploadResponseSchema = Schema.Struct({
	file: FileSummarySchema,
	url: Schema.String,
	forcedPublic: Schema.Boolean
});

export type UploadResponse = typeof UploadResponseSchema.Type;

export const AuthCheckResponseSchema = Schema.Struct({
	ok: Schema.Literal(true)
});

export const ErrorResponseSchema = Schema.Struct({
	error: Schema.String
});

export const API_KEY_PATTERN = /^adr_([A-Za-z0-9]{8})_([A-Za-z0-9_-]{24,})$/;
