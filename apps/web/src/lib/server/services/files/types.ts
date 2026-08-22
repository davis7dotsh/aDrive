import type { DashboardFile, FileDetail, FileSummary } from '@adrive/shared';
import { Schema } from 'effect';
import type { Effect } from 'effect';
import type { StoredBlob } from '../blobs';
import { InvalidRequest, NotFound, StorageError } from '../../errors';

const FileContentRow = Schema.Struct({
	id: Schema.String,
	display_name: Schema.String,
	content_type: Schema.String,
	version: Schema.Int,
	size_bytes: Schema.Int,
	is_public: Schema.Int,
	is_site: Schema.Int,
	r2_key: Schema.String,
	thumbnail_r2_key: Schema.NullOr(Schema.String),
	created_at: Schema.String
});

const FileVersionRow = Schema.Struct({
	version: Schema.Int,
	size_bytes: Schema.Int,
	content_type: Schema.String,
	created_at: Schema.String
});

export interface ListPage {
	readonly cursor: string | null;
	readonly limit: number;
}

export interface UploadInput {
	readonly displayName: string;
	readonly contentType: string;
	readonly public: boolean;
	readonly contentLength: string | null;
	readonly body: ReadableStream<Uint8Array> | null;
	readonly tags: ReadonlyArray<string>;
	readonly expiresAt: string | null;
}

export interface VersionUploadInput {
	readonly id: string;
	readonly contentType: string;
	readonly contentLength: string | null;
	readonly body: ReadableStream<Uint8Array> | null;
}

export interface FileContent {
	readonly file: FileSummary;
	readonly r2Key: string;
	readonly thumbnailR2Key: string | null;
}

export interface UploadResult {
	readonly file: FileSummary;
	readonly forcedPublic: boolean;
}

export type DashboardThumbnailStoreResult =
	| { readonly _tag: 'Stored'; readonly blob: StoredBlob }
	| { readonly _tag: 'Existing'; readonly r2Key: string };

export interface MutationResult {
	readonly file: DashboardFile;
	readonly forcedPublic: boolean;
}

export interface FilesShape {
	readonly upload: (
		input: UploadInput
	) => Effect.Effect<UploadResult, InvalidRequest | StorageError>;
	readonly uploadVersion: (
		input: VersionUploadInput
	) => Effect.Effect<MutationResult, InvalidRequest | NotFound | StorageError>;
	readonly restoreVersion: (
		id: string,
		version: number
	) => Effect.Effect<MutationResult, InvalidRequest | NotFound | StorageError>;
	readonly list: (
		trashed: boolean,
		page?: ListPage
	) => Effect.Effect<
		{
			readonly files: ReadonlyArray<DashboardFile>;
			readonly nextCursor: string | null;
		},
		InvalidRequest | StorageError
	>;
	readonly detail: (
		id: string,
		versionPage?: ListPage
	) => Effect.Effect<
		FileDetail & { readonly nextVersionsCursor: string | null },
		InvalidRequest | NotFound | StorageError
	>;
	readonly setVisibility: (
		id: string,
		isPublic: boolean
	) => Effect.Effect<MutationResult, InvalidRequest | NotFound | StorageError>;
	readonly trash: (
		id: string
	) => Effect.Effect<MutationResult, NotFound | StorageError>;
	readonly restore: (
		id: string
	) => Effect.Effect<MutationResult, InvalidRequest | NotFound | StorageError>;
	readonly setExpiration: (
		id: string,
		expiresAt: string | null
	) => Effect.Effect<MutationResult, InvalidRequest | NotFound | StorageError>;
	readonly rename: (
		id: string,
		displayName: string
	) => Effect.Effect<MutationResult, InvalidRequest | NotFound | StorageError>;
	readonly schedulePurgeNow: (
		id: string
	) => Effect.Effect<MutationResult, InvalidRequest | NotFound | StorageError>;
	readonly scheduleAllPurgesNow: Effect.Effect<number, StorageError>;
	readonly recordDownload: (id: string) => Effect.Effect<void, StorageError>;
	readonly storeDashboardThumbnail: (
		id: string,
		version: number,
		body: ReadableStream<Uint8Array> | null,
		size: number,
		expectedR2Key: string | null
	) => Effect.Effect<
		DashboardThumbnailStoreResult,
		InvalidRequest | NotFound | StorageError
	>;
	readonly sweepPurges: (limit: number) => Effect.Effect<number, StorageError>;
	readonly findContent: (
		id: string,
		version?: number,
		includeUnavailable?: boolean,
		includeSites?: boolean
	) => Effect.Effect<FileContent, InvalidRequest | NotFound | StorageError>;
}

export const decodeVersionRows = (rows: unknown) => {
	const decoded = Schema.decodeUnknownOption(Schema.Array(FileVersionRow))(
		rows
	);
	return decoded._tag === 'Some' ? decoded.value : [];
};

export const decodeContentRows = (rows: unknown) => {
	const decoded = Schema.decodeUnknownOption(Schema.Array(FileContentRow))(
		rows
	);
	return decoded._tag === 'Some' ? decoded.value : [];
};

export const toVersion = (row: typeof FileVersionRow.Type) => ({
	version: row.version,
	sizeBytes: row.size_bytes,
	contentType: row.content_type,
	createdAt: row.created_at
});
