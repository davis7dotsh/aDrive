import { normalizeSitePath } from '@adrive/shared';
import { Effect } from 'effect';
import { InvalidRequest, NotFound, StorageError } from '../../errors';
import { delaySecondsUntil } from '../../job-policy';
import { refreshSearchDocument } from '../../search-index';
import { markScanPending } from '../../scan-jobs';
import { ensureStorageHeadroom, reserveWithinPlan } from '../../storage-quota';
import { requirePublishAllowed } from '../../trust';
import { scanBeforePublish } from '../../trust-policy';
import {
	assertOpenSiteSession,
	prepareSiteManifest,
	SITE_SESSION_TTL_MS,
	validateCommittedAssets
} from '../../site-policy';
import { validateUploadLength } from '../../upload-stream';
import type { SiteInternals } from './internals';
import { ExistingSiteRow, SiteFileRow, type SitesShape } from './types';

export const sessionOps = (
	internals: SiteInternals
): Pick<SitesShape, 'createSession' | 'stageAsset' | 'commit' | 'abort'> => {
	const {
		all,
		findSession,
		stagedAssets,
		compensateStagedBlob,
		cleanupStaged,
		drainDeletes,
		sql,
		blobs,
		config,
		org,
		jobs
	} = internals;

	return {
		createSession: Effect.fn('Sites.createSession')(function* (input) {
			const prepared = yield* Effect.try({
				try: () => prepareSiteManifest(input, config.maxUploadBytes),
				catch: (cause) =>
					cause instanceof InvalidRequest
						? cause
						: new InvalidRequest({
								status: 400,
								message: 'Site manifest is invalid'
							})
			});
			// Sites are always public, so an org that may not publish is
			// refused before any asset bytes are accepted.
			yield* requirePublishAllowed(sql, org.id);
			// Declared manifest sizes gate the whole publish before any asset
			// bytes are accepted; per-asset uploads re-verify actual lengths.
			const declaredBytes = prepared.assets.reduce(
				(total, asset) => total + asset.sizeBytes,
				0
			);

			let fileId: string = crypto.randomUUID();
			let version = 1;
			let displayName = prepared.displayName;
			let previousBytes = 0;
			if (input.fileId !== undefined) {
				const rows = yield* all(
					sql`
						SELECT id, display_name, current_version, size_bytes
						FROM files
						WHERE id = ${input.fileId} AND org_id = ${org.id}
							AND is_site = true AND deleted_at IS NULL
						LIMIT 1`,
					ExistingSiteRow,
					'find site to republish'
				);
				const current = rows[0];
				if (!current) return yield* new NotFound({ id: input.fileId });
				fileId = current.id;
				version = current.current_version + 1;
				displayName = current.display_name;
				previousBytes = current.size_bytes;
			}
			// A republish replaces the previous assets, so preflight the same
			// byte delta the commit will charge. Actual asset lengths and the
			// authoritative reservation are still checked during publication.
			yield* ensureStorageHeadroom(sql, org.id, declaredBytes - previousBytes);

			const id = crypto.randomUUID();
			const createdAt = new Date().toISOString();
			const expiresAt = new Date(
				new Date(createdAt).getTime() + SITE_SESSION_TTL_MS
			).toISOString();
			yield* sql
				.withTransaction(
					Effect.gen(function* () {
						yield* sql`
								INSERT INTO site_upload_sessions (
									id, org_id, file_id, display_name, version, status, created_at,
									expires_at
								) VALUES (
									${id}, ${org.id}, ${fileId}, ${displayName}, ${version}, 'open',
									${createdAt}, ${expiresAt}
								)`;
						for (const asset of prepared.assets) {
							yield* sql`
								INSERT INTO staged_site_assets (
									session_id, path, expected_size_bytes, content_type
								) VALUES (
									${id}, ${asset.path}, ${asset.sizeBytes}, ${asset.contentType}
								)`;
						}
					})
				)
				.pipe(
					Effect.mapError(
						(cause) =>
							new StorageError({
								operation: 'create site upload session',
								cause
							})
					)
				);
			// Abandoned sessions are cleaned when the TTL is up.
			yield* jobs.trySend(
				{ kind: 'site-cleanup', orgId: org.id, sessionId: id },
				{ delaySeconds: delaySecondsUntil(expiresAt) }
			);
			yield* drainDeletes(fileId).pipe(
				Effect.catchCause((cause) =>
					Effect.sync(() => {
						console.error(
							JSON.stringify({
								message: 'deferred site cleanup retry failed',
								fileId,
								cause: String(cause)
							})
						);
					})
				)
			);
			return { sessionId: id, fileId, version, expiresAt };
		}),
		stageAsset: Effect.fn('Sites.stageAsset')(function* (input) {
			const session = yield* findSession(input.sessionId);
			yield* Effect.try({
				try: () => assertOpenSiteSession(session, new Date()),
				catch: (cause) =>
					cause instanceof InvalidRequest
						? cause
						: new InvalidRequest({
								status: 409,
								message: 'Site upload session is unavailable'
							})
			});
			const path = yield* Effect.try({
				try: () => normalizeSitePath(input.path),
				catch: () =>
					new InvalidRequest({
						status: 400,
						message: 'Site asset path is unsafe'
					})
			});
			const assets = yield* stagedAssets(session.id);
			const asset = assets.find((candidate) => candidate.path === path);
			if (!asset) return yield* new NotFound({ id: path });
			if (asset.r2Key !== null) {
				return yield* new InvalidRequest({
					status: 409,
					message: 'Site asset was already uploaded'
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
								message: 'Site asset length is invalid'
							})
			});
			if (size !== asset.expectedSizeBytes) {
				return yield* new InvalidRequest({
					status: 409,
					message: 'Site asset length does not match the manifest'
				});
			}

			const r2Key = `s/${session.fileId}/${session.version}/${crypto.randomUUID()}`;
			const stored = yield* blobs.put(
				r2Key,
				input.body,
				size,
				asset.contentType
			);
			const uploadedAt = new Date().toISOString();
			const updated = yield* sql
				.withTransaction(
					Effect.gen(function* () {
						// Cleanup also locks the session before touching staged rows.
						// Recheck after waiting so a late upload cannot lose its blob
						// record behind an abort or an expiry sweep.
						const open = yield* sql`
						SELECT id FROM site_upload_sessions
						WHERE id = ${session.id} AND org_id = ${org.id} AND status = 'open'
							AND expires_at > ${uploadedAt}
						FOR UPDATE`;
						if (open.length === 0) return [];
						return yield* sql<{ path: string }>`
						UPDATE staged_site_assets
						SET r2_key = ${r2Key}, stored_size_bytes = ${stored.size},
							uploaded_at = ${uploadedAt}
						WHERE session_id = ${session.id} AND path = ${path} AND r2_key IS NULL
						RETURNING path`;
					})
				)
				.pipe(
					Effect.mapError(
						(cause) =>
							new StorageError({ operation: 'record staged site asset', cause })
					),
					Effect.catch((failure) =>
						compensateStagedBlob(session, r2Key).pipe(
							Effect.andThen(Effect.fail(failure))
						)
					)
				);
			if (updated.length !== 1) {
				yield* compensateStagedBlob(session, r2Key);
				return yield* new InvalidRequest({
					status: 409,
					message: 'Site upload session changed while the asset was uploading'
				});
			}
			return { path, sizeBytes: stored.size, contentType: asset.contentType };
		}),
		commit: Effect.fn('Sites.commit')(function* (sessionId) {
			const session = yield* findSession(sessionId);
			yield* Effect.try({
				try: () => assertOpenSiteSession(session, new Date()),
				catch: (cause) =>
					cause instanceof InvalidRequest
						? cause
						: new InvalidRequest({
								status: 409,
								message: 'Site upload session is unavailable'
							})
			});
			// A verified org's site goes live once the scanner clears it; an
			// established org's is live now and scanned after.
			yield* requirePublishAllowed(sql, org.id);
			const assets = yield* stagedAssets(session.id);
			const totalSize = yield* Effect.try({
				try: () => validateCommittedAssets(assets),
				catch: (cause) =>
					cause instanceof InvalidRequest
						? cause
						: new InvalidRequest({
								status: 409,
								message: 'Site assets are incomplete'
							})
			});
			const publishedAt = new Date().toISOString();
			const versionKey = `site-version/${session.fileId}/${session.version}/${session.id}`;
			const guard =
				session.version === 1
					? sql<{ id: string }>`
							UPDATE site_upload_sessions
							SET status = 'committing'
							WHERE id = ${session.id} AND org_id = ${org.id} AND status = 'open'
								AND expires_at > ${publishedAt}
								AND NOT EXISTS (SELECT 1 FROM files WHERE id = ${session.fileId})
							RETURNING id`
					: sql<{ id: string }>`
							UPDATE site_upload_sessions
							SET status = 'committing'
							WHERE id = ${session.id} AND org_id = ${org.id} AND status = 'open'
								AND expires_at > ${publishedAt}
								AND EXISTS (
									SELECT 1 FROM files
									WHERE id = ${session.fileId} AND org_id = ${org.id}
										AND is_site = true
										AND deleted_at IS NULL
										AND quarantined = false
										AND current_version = ${session.version - 1}
								)
							RETURNING id`;

			const commit = sql
				.withTransaction(
					Effect.gen(function* () {
						if (session.version > 1) {
							// Purge claims this row before enumerating blobs. Hold it
							// through publication so purge either sees the new version
							// or makes this publish ineligible before any promotion.
							const current = yield* sql<{ id: string }>`
								SELECT id FROM files
								WHERE id = ${session.fileId} AND is_site = true
									AND current_version = ${session.version - 1}
									AND deleted_at IS NULL AND purge_state = 'none'
									AND (expires_at IS NULL OR expires_at > ${publishedAt})
								FOR UPDATE`;
							if (current.length !== 1) {
								return yield* new StorageError({
									operation: 'commit site version',
									cause: 'The site changed while it was publishing'
								});
							}
						}
						const hold = scanBeforePublish(
							yield* requirePublishAllowed(sql, org.id)
						);
						const guarded = yield* guard;
						if (guarded.length !== 1) {
							return yield* new StorageError({
								operation: 'commit site version',
								cause: 'The site changed while it was publishing'
							});
						}
						// The previous version's assets leave R2 after commit, so
						// the org is charged only the difference.
						const previous =
							session.version === 1
								? []
								: yield* sql<{ size_bytes: number }>`
										SELECT size_bytes FROM files
										WHERE id = ${session.fileId} AND org_id = ${org.id}`;
						const previousBytes = previous[0]?.size_bytes ?? 0;
						yield* sql`
								INSERT INTO files (
									id, org_id, display_name, content_type, kind, current_version,
									size_bytes, public, publish_pending, is_site, created_at,
									updated_at, index_state
								)
								SELECT file_id, org_id, display_name, 'text/html', 'site', 1,
									${totalSize}, ${!hold}, ${hold}, true, ${publishedAt},
									${publishedAt}, 'pending'
								FROM site_upload_sessions
								WHERE id = ${session.id} AND status = 'committing' AND version = 1
								ON CONFLICT (id) DO NOTHING`;
						yield* sql`
							UPDATE files
							SET current_version = ${session.version}, size_bytes = ${totalSize},
								content_type = 'text/html', public = ${!hold},
								publish_pending = ${hold},
								updated_at = ${publishedAt}, index_state = 'pending',
								index_cursor = 0, index_attempts = 0, index_error = NULL,
								index_next_run_at = NULL, index_lease_token = NULL
							WHERE id = ${session.fileId} AND org_id = ${org.id}
								AND current_version = ${session.version - 1}
								AND is_site = true
								AND EXISTS (
									SELECT 1 FROM site_upload_sessions
									WHERE id = ${session.id} AND status = 'committing'
										AND version > 1
								)`;
						yield* sql`
								INSERT INTO file_versions (
									file_id, org_id, version, r2_key, size_bytes, sha256,
									content_type, created_at, text_content
								)
								SELECT s.file_id, s.org_id, s.version, ${versionKey}, ${totalSize},
									NULL, 'text/html', ${publishedAt}, NULL
								FROM site_upload_sessions s
							JOIN files f ON f.id = s.file_id
							WHERE s.id = ${session.id} AND s.status = 'committing'
								AND f.current_version = s.version`;
						yield* sql`
							INSERT INTO pending_site_asset_deletes (
								r2_key, file_id, version, queued_at
							)
							SELECT old.r2_key, old.file_id, old.version, ${publishedAt}
							FROM site_assets old
							WHERE old.file_id = ${session.fileId}
								AND old.version <> ${session.version}
								AND EXISTS (
									SELECT 1 FROM site_upload_sessions
									WHERE id = ${session.id} AND status = 'committing'
								)
							ON CONFLICT (r2_key) DO NOTHING`;
						yield* sql`
							DELETE FROM site_assets
							WHERE file_id = ${session.fileId} AND version <> ${session.version}
								AND EXISTS (
									SELECT 1 FROM site_upload_sessions
									WHERE id = ${session.id} AND status = 'committing'
								)`;
						yield* sql`
							INSERT INTO site_assets (
								file_id, version, path, r2_key, content_type, size_bytes
							)
							SELECT s.file_id, s.version, a.path, a.r2_key, a.content_type,
								a.stored_size_bytes
							FROM site_upload_sessions s
							JOIN staged_site_assets a ON a.session_id = s.id
							WHERE s.id = ${session.id} AND s.status = 'committing'
								AND a.r2_key IS NOT NULL AND a.stored_size_bytes IS NOT NULL`;
						yield* refreshSearchDocument(sql, session.fileId, org.id);
						yield* markScanPending(
							sql,
							org.id,
							session.fileId,
							session.version
						);
						yield* sql`
							UPDATE site_upload_sessions SET status = 'complete'
							WHERE id = ${session.id} AND status = 'committing'
								AND (
									SELECT COUNT(*) FROM staged_site_assets
									WHERE session_id = ${session.id}
								) = (
									SELECT COUNT(*) FROM site_assets
									WHERE file_id = ${session.fileId}
										AND version = ${session.version}
								)`;
						yield* sql`
							DELETE FROM staged_site_assets
							WHERE session_id = ${session.id} AND EXISTS (
								SELECT 1 FROM site_upload_sessions
								WHERE id = ${session.id} AND status = 'complete'
							)`;
						yield* reserveWithinPlan(sql, org.id, totalSize - previousBytes);
						return hold;
					})
				)
				.pipe(
					Effect.catchTag('SqlError', (cause) =>
						Effect.fail(
							new StorageError({ operation: 'commit site version', cause })
						)
					)
				);
			const hold = yield* commit.pipe(
				Effect.catch((failure) =>
					cleanupStaged(session, 'aborted').pipe(
						Effect.catchCause((cleanupCause) =>
							Effect.sync(() => {
								console.error(
									JSON.stringify({
										message: 'site publish compensation failed',
										sessionId,
										cause: String(cleanupCause)
									})
								);
							})
						),
						Effect.andThen(Effect.fail(failure))
					)
				)
			);

			yield* jobs.trySend({
				kind: 'index',
				orgId: org.id,
				fileId: session.fileId,
				version: session.version
			});
			yield* jobs.trySend({
				kind: 'scan',
				orgId: org.id,
				fileId: session.fileId,
				version: session.version
			});
			const cleanupPending = yield* drainDeletes(session.fileId).pipe(
				Effect.catchCause((cause) =>
					Effect.sync(() => {
						console.error(
							JSON.stringify({
								message: 'published site cleanup remains pending',
								fileId: session.fileId,
								cause: String(cause)
							})
						);
						return true;
					})
				)
			);
			const rows = yield* all(
				sql`
					SELECT id, display_name, current_version, size_bytes, created_at,
						expires_at, download_count, last_download_at
					FROM files
					WHERE id = ${session.fileId} AND org_id = ${org.id} AND is_site = true
						AND current_version = ${session.version}
					LIMIT 1`,
				SiteFileRow,
				'read published site'
			);
			const file = rows[0];
			if (!file) {
				return yield* new StorageError({
					operation: 'read published site',
					cause: 'Committed site metadata was not found'
				});
			}
			return {
				file: {
					id: file.id,
					displayName: file.display_name,
					contentType: 'text/html',
					kind: 'site',
					version: file.current_version,
					sizeBytes: file.size_bytes,
					public: !hold,
					createdAt: file.created_at,
					expiresAt: file.expires_at,
					downloadCount: file.download_count,
					lastDownloadAt: file.last_download_at,
					indexState: 'pending',
					indexedVersion: null,
					indexAttempts: 0,
					indexError: null
				},
				assetCount: assets.length,
				cleanupPending
			};
		}),
		abort: Effect.fn('Sites.abort')(function* (sessionId) {
			const session = yield* findSession(sessionId);
			if (session.status === 'complete') {
				return yield* new NotFound({ id: sessionId });
			}
			yield* cleanupStaged(session, 'aborted');
		})
	};
};
