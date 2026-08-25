import { type SitePublish } from '@adrive/shared';
import { Effect, Schema } from 'effect';
import { InvalidRequest } from '../../errors';
import { MAX_SITE_ASSETS } from '../../site-policy';
import {
	renderSiteIndex,
	siteAssetPathFor,
	type GalleryAsset
} from '../../site-gallery';
import type { SiteInternals } from './internals';
import { decodeRows, type SitesShape } from './types';

const SourceRow = Schema.Struct({
	id: Schema.String,
	display_name: Schema.String,
	r2_key: Schema.String,
	content_type: Schema.String,
	size_bytes: Schema.Int
});

const TagMemberRow = Schema.Struct({ file_id: Schema.String });

const bytesToStream = (bytes: Uint8Array) =>
	new ReadableStream<Uint8Array>({
		start(controller) {
			controller.enqueue(bytes);
			controller.close();
		}
	});

interface PlannedAsset extends GalleryAsset {
	readonly sourceKey: string | null; // null for the generated index
	readonly generated: Uint8Array | null;
}

export const publishOps = (
	internals: SiteInternals,
	session: Pick<SitesShape, 'createSession' | 'stageAsset' | 'commit' | 'abort'>
): Pick<SitesShape, 'publishFromFiles'> => {
	const { all, db } = internals;

	const collectSourceIds = (input: SitePublish) =>
		Effect.gen(function* () {
			const explicit = [
				...new Set((input.fileIds ?? []).map((id) => id.trim()).filter(Boolean))
			];
			if (input.tagId === undefined) return explicit;
			const rows = yield* all(
				db
					.prepare('SELECT file_id FROM file_tags WHERE tag_id = ?')
					.bind(input.tagId),
				TagMemberRow,
				'list files for tag'
			);
			return [...new Set([...explicit, ...rows.map((row) => row.file_id)])];
		});

	return {
		publishFromFiles: Effect.fn('Sites.publishFromFiles')(function* (input) {
			const ids = yield* collectSourceIds(input);
			if (ids.length === 0) {
				return yield* new InvalidRequest({
					status: 400,
					message: 'Select at least one file or a tag to publish'
				});
			}
			if (ids.length > MAX_SITE_ASSETS) {
				return yield* new InvalidRequest({
					status: 400,
					message: `A site can publish at most ${MAX_SITE_ASSETS} files`
				});
			}
			if (
				input.fileId === undefined &&
				(input.displayName ?? '').trim() === ''
			) {
				return yield* new InvalidRequest({
					status: 400,
					message: 'A site name is required for a new site'
				});
			}
			const now = new Date().toISOString();
			const placeholders = ids.map(() => '?').join(', ');
			const rows = yield* all(
				db
					.prepare(
						`SELECT f.id, f.display_name, v.r2_key, v.content_type, v.size_bytes
						FROM files f
						JOIN file_versions v
							ON v.file_id = f.id AND v.version = f.current_version
						WHERE f.is_site = 0 AND f.deleted_at IS NULL
							AND (f.expires_at IS NULL OR f.expires_at > ?)
							AND f.id IN (${placeholders})
						ORDER BY f.display_name, f.id`
					)
					.bind(now, ...ids),
				SourceRow,
				'load files to publish'
			);
			if (rows.length === 0) {
				return yield* new InvalidRequest({
					status: 400,
					message: 'None of the selected files can be published'
				});
			}

			const taken = new Set<string>();
			const planned: Array<PlannedAsset> = rows.map((row, index) => {
				const path = siteAssetPathFor(
					row.display_name,
					taken,
					`file-${index + 1}`
				);
				taken.add(path);
				return {
					path,
					displayName: row.display_name,
					contentType: row.content_type,
					sizeBytes: row.size_bytes,
					sourceKey: row.r2_key,
					generated: null
				};
			});

			// Reuse an existing index.html when the selection already contains one;
			// otherwise synthesize a gallery/listing so a folder of files becomes a
			// browsable URL.
			if (!taken.has('index.html')) {
				const html = new TextEncoder().encode(
					renderSiteIndex(
						(input.displayName ?? 'Files').trim() || 'Files',
						planned.map((asset) => ({
							path: asset.path,
							displayName: asset.displayName,
							contentType: asset.contentType,
							sizeBytes: asset.sizeBytes
						}))
					)
				);
				planned.unshift({
					path: 'index.html',
					displayName: 'index.html',
					contentType: 'text/html',
					sizeBytes: html.byteLength,
					sourceKey: null,
					generated: html
				});
			}

			const created = yield* session.createSession({
				displayName: (input.displayName ?? '').trim() || 'site',
				...(input.fileId !== undefined ? { fileId: input.fileId } : {}),
				assets: planned.map((asset) => ({
					path: asset.path,
					sizeBytes: asset.sizeBytes,
					contentType: asset.contentType
				}))
			});

			// Copy each source's current bytes straight from R2 into the staged
			// site upload (no client re-upload), then commit through the same
			// state machine the upload flow uses.
			return yield* Effect.forEach(
				planned,
				(asset) =>
					Effect.gen(function* () {
						const body =
							asset.generated !== null
								? bytesToStream(asset.generated)
								: (yield* internals.blobs.get(asset.sourceKey!)).body;
						yield* session.stageAsset({
							sessionId: created.sessionId,
							path: asset.path,
							contentLength: String(asset.sizeBytes),
							body
						});
					}),
				{ concurrency: 4, discard: true }
			).pipe(
				Effect.andThen(session.commit(created.sessionId)),
				Effect.catch((failure) =>
					session
						.abort(created.sessionId)
						.pipe(Effect.ignore, Effect.andThen(Effect.fail(failure)))
				)
			);
		})
	};
};
