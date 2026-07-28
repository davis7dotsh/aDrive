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
