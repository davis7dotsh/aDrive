import {
	cleanFileName,
	contentTypeForUpload,
	visibilityForFile
} from '../../file-policy';
import { InvalidRequest, NotFound, StorageError } from '../../errors';
import { fileIndexStatements } from '../../search-index';
import { validateUploadLength } from '../../upload-stream';
import { forgetTagListCache } from '../tags';
import { Effect } from 'effect';
import type { FileInternals } from './internals';
import type { FilesShape } from './types';
import { decodeContentRows } from './types';

export const uploadOps = (
	internals: FileInternals
): Pick<FilesShape, 'upload' | 'uploadVersion' | 'restoreVersion'> => {
	const { db, blobs, sql, config, tags } = internals;
	const {
		checkStorageQuota,
		compensateStoredBlob,
		commitStoredVersion,
		findDashboardFile
	} = internals;
	return {
		upload: Effect.fn('Files.upload')(function* (input) {
			const size = yield* Effect.try({
				try: () =>
					validateUploadLength(input.contentLength, config.maxUploadBytes),
				catch: (cause) =>
					cause instanceof InvalidRequest
						? cause
						: new InvalidRequest({
								status: 400,
								message: 'Upload length is invalid'
							})
			});
			const displayName = yield* Effect.try({
				try: () => cleanFileName(input.displayName),
				catch: (cause) =>
					cause instanceof InvalidRequest
						? cause
						: new InvalidRequest({
								status: 400,
								message: 'File name is invalid'
							})
			});
			yield* checkStorageQuota(size);
			const contentType = contentTypeForUpload(displayName, input.contentType);
			const visibility = visibilityForFile(
				displayName,
				contentType,
				input.public
			);
			const id = crypto.randomUUID();
			const resolvedTags = yield* tags.resolveNames(input.tags);
			const r2Key = `v/${id}/${crypto.randomUUID()}`;
			const createdAt = new Date().toISOString();
			const stored = yield* blobs.put(r2Key, input.body, size, contentType);
			const statements = [
				db
					.prepare(
						`INSERT INTO files (
							id, display_name, content_type, kind, current_version, size_bytes,
							public, is_site, created_at, updated_at, expires_at, index_state
						) VALUES (?, ?, ?, 'file', 1, ?, ?, 0, ?, ?, ?, 'pending')`
					)
					.bind(
						id,
						displayName,
						contentType,
						stored.size,
						visibility.public ? 1 : 0,
						createdAt,
						createdAt,
						input.expiresAt
					),
				db
					.prepare(
						`INSERT INTO file_versions (
							file_id, version, r2_key, size_bytes, sha256, content_type, created_at,
							text_content
						) VALUES (?, 1, ?, ?, NULL, ?, ?, ?)`
					)
					.bind(id, r2Key, stored.size, contentType, createdAt, null),
				...resolvedTags.map((tag) =>
					db
						.prepare('INSERT INTO file_tags (file_id, tag_id) VALUES (?, ?)')
						.bind(id, tag.id)
				),
				...fileIndexStatements(db, id)
			];

			const commit = Effect.tryPromise({
				try: () => db.batch(statements),
				catch: (cause) =>
					new StorageError({ operation: 'commit file metadata', cause })
			});
			yield* commit.pipe(
				Effect.catch((failure) =>
					compensateStoredBlob(failure, id, 1, r2Key, 'upload')
				)
			);
			forgetTagListCache(db);

			return {
				file: {
					id,
					displayName,
					contentType,
					kind: 'file',
					version: 1,
					sizeBytes: stored.size,
					public: visibility.public,
					createdAt,
					expiresAt: input.expiresAt,
					downloadCount: 0,
					lastDownloadAt: null,
					indexState: 'pending',
					indexedVersion: null,
					indexAttempts: 0,
					indexError: null
				},
				forcedPublic: visibility.forcedPublic
			};
		}),
		uploadVersion: Effect.fn('Files.uploadVersion')(function* (input) {
			const current = yield* findDashboardFile(input.id);
			if (current.deletedAt !== null)
				return yield* new NotFound({ id: input.id });
			if (current.kind === 'site') {
				return yield* new InvalidRequest({
					status: 400,
					message: 'Republish sites with `adrive site put`'
				});
			}
			const size = yield* Effect.try({
				try: () =>
					validateUploadLength(input.contentLength, config.maxUploadBytes),
				catch: (cause) =>
					cause instanceof InvalidRequest
						? cause
						: new InvalidRequest({
								status: 400,
								message: 'Upload length is invalid'
							})
			});
			yield* checkStorageQuota(size);
			const contentType = contentTypeForUpload(
				current.displayName,
				input.contentType
			);
			const r2Key = `v/${current.id}/${crypto.randomUUID()}`;
			const stored = yield* blobs.put(r2Key, input.body, size, contentType);
			const commit = commitStoredVersion(
				current,
				r2Key,
				stored.size,
				contentType
			);
			return yield* commit.pipe(
				Effect.catch((failure) =>
					compensateStoredBlob(
						failure,
						current.id,
						current.version + 1,
						r2Key,
						'version upload'
					)
				)
			);
		}),
		restoreVersion: Effect.fn('Files.restoreVersion')(function* (id, version) {
			if (!Number.isSafeInteger(version) || version < 1) {
				return yield* new InvalidRequest({
					status: 400,
					message: 'Version is invalid'
				});
			}
			const current = yield* findDashboardFile(id);
			if (current.deletedAt !== null) return yield* new NotFound({ id });
			if (current.kind === 'site') {
				return yield* new InvalidRequest({
					status: 400,
					message: 'Republish sites with `adrive site put`'
				});
			}
			if (current.version === version) {
				return yield* new InvalidRequest({
					status: 409,
					message: 'That version is already current'
				});
			}
			const rows = yield* sql`
				SELECT
					f.id, f.display_name, v.content_type, v.version, v.size_bytes,
					f.public AS is_public, f.is_site, v.r2_key, v.thumbnail_r2_key, v.created_at
				FROM files f
				JOIN file_versions v ON v.file_id = f.id
				WHERE f.id = ${id} AND v.version = ${version}
					AND f.deleted_at IS NULL AND f.is_site = 0
				LIMIT 1
			`.pipe(
				Effect.mapError(
					(cause) =>
						new StorageError({ operation: 'find version to restore', cause })
				)
			);
			const source = decodeContentRows(rows)[0];
			if (!source) return yield* new NotFound({ id });
			yield* checkStorageQuota(source.size_bytes);
			const sourceObject = yield* blobs.get(source.r2_key);
			const r2Key = `v/${current.id}/${crypto.randomUUID()}`;
			const stored = yield* blobs.put(
				r2Key,
				sourceObject.body,
				source.size_bytes,
				source.content_type
			);
			return yield* commitStoredVersion(
				current,
				r2Key,
				stored.size,
				source.content_type
			).pipe(
				Effect.catch((failure) =>
					compensateStoredBlob(
						failure,
						current.id,
						current.version + 1,
						r2Key,
						'version restore'
					)
				)
			);
		})
	} satisfies Pick<FilesShape, 'upload' | 'uploadVersion' | 'restoreVersion'>;
};
