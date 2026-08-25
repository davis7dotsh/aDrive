import {
	type FileSummary,
	type SitePublish,
	type SiteSessionCreate
} from '@adrive/shared';
import { Effect, Schema } from 'effect';
import { InvalidRequest, NotFound, StorageError } from '../../errors';

export const SiteSessionRow = Schema.Struct({
	id: Schema.String,
	file_id: Schema.String,
	display_name: Schema.String,
	version: Schema.Int,
	status: Schema.String,
	created_at: Schema.String,
	expires_at: Schema.String
});

export const StagedAssetRow = Schema.Struct({
	path: Schema.String,
	expected_size_bytes: Schema.Int,
	content_type: Schema.String,
	r2_key: Schema.NullOr(Schema.String),
	stored_size_bytes: Schema.NullOr(Schema.Int)
});

export const ExistingSiteRow = Schema.Struct({
	id: Schema.String,
	display_name: Schema.String,
	current_version: Schema.Int
});

export const SiteFileRow = Schema.Struct({
	id: Schema.String,
	display_name: Schema.String,
	current_version: Schema.Int,
	size_bytes: Schema.Int,
	created_at: Schema.String,
	expires_at: Schema.NullOr(Schema.String),
	download_count: Schema.Int,
	last_download_at: Schema.NullOr(Schema.String)
});

export const SiteAssetRow = Schema.Struct({
	path: Schema.String,
	r2_key: Schema.String,
	content_type: Schema.String,
	size_bytes: Schema.Int
});

export const PendingDeleteRow = Schema.Struct({
	r2_key: Schema.String
});

export const decodeRows = <A, I>(
	schema: Schema.Codec<A, I, never>,
	rows: unknown
) => {
	const decoded = Schema.decodeUnknownOption(Schema.Array(schema))(rows);
	return decoded._tag === 'Some' ? decoded.value : [];
};

export interface StageAssetInput {
	readonly sessionId: string;
	readonly path: string;
	readonly contentLength: string | null;
	readonly body: ReadableStream<Uint8Array> | null;
}

export interface SiteSession {
	readonly sessionId: string;
	readonly fileId: string;
	readonly version: number;
	readonly expiresAt: string;
}

export interface SiteCommitResult {
	readonly file: FileSummary;
	readonly assetCount: number;
	readonly cleanupPending: boolean;
}

export interface SiteContent {
	readonly path: string;
	readonly r2Key: string;
	readonly contentType: string;
	readonly sizeBytes: number;
}

export interface SitesShape {
	readonly createSession: (
		input: SiteSessionCreate
	) => Effect.Effect<SiteSession, InvalidRequest | NotFound | StorageError>;
	readonly stageAsset: (input: StageAssetInput) => Effect.Effect<
		{
			readonly path: string;
			readonly sizeBytes: number;
			readonly contentType: string;
		},
		InvalidRequest | NotFound | StorageError
	>;
	readonly commit: (
		sessionId: string
	) => Effect.Effect<
		SiteCommitResult,
		InvalidRequest | NotFound | StorageError
	>;
	readonly publishFromFiles: (
		input: SitePublish
	) => Effect.Effect<
		SiteCommitResult,
		InvalidRequest | NotFound | StorageError
	>;
	readonly abort: (
		sessionId: string
	) => Effect.Effect<void, NotFound | StorageError>;
	readonly findAsset: (
		fileId: string,
		requestPath: string,
		options?: {
			readonly includeUnavailable?: boolean;
			readonly version?: number;
		}
	) => Effect.Effect<SiteContent, InvalidRequest | NotFound | StorageError>;
	readonly sweepLifecycle: (
		limit: number
	) => Effect.Effect<number, StorageError>;
}
