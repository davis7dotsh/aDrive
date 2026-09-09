import { Cause, Context, Effect, Layer, Schema } from 'effect';
import { StorageError } from '../errors';
import {
	claimIndex,
	finishKeywordOnly,
	recordIndexFailure,
	semanticCommit,
	storeExtractedText,
	type IndexLease
} from '../indexing-sql';
import {
	MAX_INDEX_ATTEMPTS,
	chunkSearchText,
	indexFailureDisposition,
	newIndexLeaseToken,
	safeIndexError
} from '../semantic-policy';
import { isSearchableText, searchTextLimit } from '../search-text';
import { createTtlCache } from '../isolate-cache';
import { PgSql } from '../pg';
import { Blobs } from './blobs';
import { CurrentOrg } from './current-org';
import { Embedder, VectorIndex } from './semantic';

const INDEX_LEASE_MS = 5 * 60 * 1_000;
const EMBEDDING_MODEL = '@cf/baai/bge-small-en-v1.5';
const SEMANTIC_STATUS_CACHE_TTL_MS = 10_000;
// Per isolate, per org; the Postgres client is rebuilt per request so it
// cannot be the key.
const semanticStatusCache = createTtlCache<SemanticStatus>(
	SEMANTIC_STATUS_CACHE_TTL_MS
);

const IndexJobRow = Schema.Struct({
	id: Schema.String,
	display_name: Schema.String,
	content_type: Schema.String,
	kind: Schema.String,
	current_version: Schema.Int,
	r2_key: Schema.String,
	text_content: Schema.NullOr(Schema.String),
	index_state: Schema.String,
	index_cursor: Schema.Int,
	index_attempts: Schema.Int,
	index_next_run_at: Schema.NullOr(Schema.String)
});

const decodeRows = <A, I>(schema: Schema.Codec<A, I, never>, rows: unknown) => {
	const decoded = Schema.decodeUnknownOption(Schema.Array(schema))(rows);
	return decoded._tag === 'Some' ? decoded.value : [];
};

export interface SemanticStatus {
	readonly enabled: boolean;
	readonly indexedChunks: number;
	readonly dimensions: number;
	readonly model: string;
	readonly costNotice: string;
}

export interface IndexingShape {
	readonly enqueue: (fileId: string) => Effect.Effect<void, StorageError>;
	readonly process: (fileId: string) => Effect.Effect<void, StorageError>;
	readonly runDue: (limit: number) => Effect.Effect<number, StorageError>;
	readonly status: Effect.Effect<SemanticStatus, StorageError>;
}

export class Indexing extends Context.Service<Indexing, IndexingShape>()(
	'app/Indexing'
) {}

const makeIndexing = Effect.gen(function* () {
	const sql = yield* PgSql;
	const org = yield* CurrentOrg;
	const blobs = yield* Blobs;
	const embedder = yield* Embedder;
	const vectors = yield* VectorIndex;

	const storage = (operation: string) => (cause: unknown) =>
		new StorageError({ operation, cause });

	const findJob = Effect.fn('Indexing.findJob')(function* (fileId: string) {
		const rows = yield* sql`
			SELECT
				f.id, f.display_name, f.content_type, f.kind, f.current_version,
				v.r2_key, v.text_content, f.index_state,
				f.index_cursor, f.index_attempts, f.index_next_run_at
			FROM files f
			JOIN file_versions v
				ON v.file_id = f.id AND v.version = f.current_version
			WHERE f.id = ${fileId} AND f.org_id = ${org.id} AND f.deleted_at IS NULL
				AND (f.expires_at IS NULL OR f.expires_at > ${new Date().toISOString()})
			LIMIT 1`.pipe(Effect.mapError(storage('find indexing job')));
		return decodeRows(IndexJobRow, rows)[0] ?? null;
	});

	const markFailure = Effect.fn('Indexing.markFailure')(function* (
		lease: IndexLease,
		cause: unknown
	) {
		const disposition = indexFailureDisposition(lease.attempt);
		const error = safeIndexError(cause);
		const stateChanged = yield* recordIndexFailure(sql, lease, {
			...disposition,
			error
		}).pipe(Effect.mapError(storage('record indexing failure')));
		console.error(
			JSON.stringify({
				message: !stateChanged
					? 'stale semantic indexing failure ignored'
					: disposition.state === 'failed'
						? 'semantic indexing reached its retry limit'
						: 'semantic indexing will retry',
				fileId: lease.fileId,
				version: lease.version,
				attempt: lease.attempt,
				error
			})
		);
	});

	const perform = Effect.fn('Indexing.perform')(function* (fileId: string) {
		const initial = yield* findJob(fileId);
		if (!initial) return;
		const now = new Date();
		const leaseUntil = new Date(now.getTime() + INDEX_LEASE_MS).toISOString();
		const lease = {
			orgId: org.id,
			fileId,
			version: initial.current_version,
			attempt: initial.index_attempts + 1,
			token: newIndexLeaseToken()
		} satisfies IndexLease;
		const claimed = yield* claimIndex(
			sql,
			lease,
			now.toISOString(),
			leaseUntil,
			MAX_INDEX_ATTEMPTS
		).pipe(Effect.mapError(storage('claim indexing job')));
		if (!claimed) return;

		const stale = (message: string) =>
			Effect.sync(() => {
				console.log(
					JSON.stringify({
						message,
						fileId,
						version: lease.version,
						attempt: lease.attempt
					})
				);
			});

		yield* Effect.gen(function* () {
			const text =
				initial.index_cursor >= 1 && initial.text_content !== null
					? initial.text_content
					: initial.kind === 'file' &&
						  isSearchableText(initial.display_name, initial.content_type)
						? yield* blobs.readTextPrefix(initial.r2_key, searchTextLimit)
						: '';

			const extracted = yield* storeExtractedText(sql, lease, text).pipe(
				Effect.mapError(storage('store extracted search text'))
			);
			if (!extracted) {
				return yield* stale('stale semantic extraction ignored');
			}

			if (!embedder.enabled || !vectors.enabled) {
				const finished = yield* finishKeywordOnly(sql, lease).pipe(
					Effect.mapError(storage('finish keyword-only indexing'))
				);
				if (!finished) {
					yield* stale('stale keyword-only indexing completion ignored');
				}
				return;
			}

			const chunks = chunkSearchText(initial.display_name, text);
			const embeddings = yield* embedder.documents(
				chunks.map((chunk) => chunk.text)
			);
			if (embeddings.length !== chunks.length) {
				return yield* new StorageError({
					operation: 'validate embeddings',
					cause: 'Workers AI returned a different number of embeddings'
				});
			}

			const committed = yield* semanticCommit(
				sql,
				lease,
				chunks.map((chunk, index) => ({
					fileId,
					version: lease.version,
					ordinal: chunk.ordinal,
					charStart: chunk.charStart,
					charEnd: chunk.charEnd,
					values: embeddings[index] ?? []
				}))
			).pipe(Effect.mapError(storage('commit semantic index state')));
			if (!committed) {
				yield* stale('stale semantic indexing completion rolled back');
			}
		}).pipe(
			Effect.catchCause((cause) =>
				markFailure(lease, Cause.pretty(cause)).pipe(
					Effect.catchCause((recordCause) =>
						Effect.sync(() => {
							console.error(
								JSON.stringify({
									message: 'could not persist indexing failure',
									fileId,
									version: lease.version,
									attempt: lease.attempt,
									cause: String(recordCause)
								})
							);
						})
					)
				)
			)
		);
	});

	const process = Effect.fn('Indexing.process')(function* (fileId: string) {
		yield* perform(fileId).pipe(
			Effect.catchCause((cause) =>
				Effect.sync(() => {
					console.error(
						JSON.stringify({
							message: 'could not start indexing job',
							fileId,
							cause: Cause.pretty(cause)
						})
					);
				})
			)
		);
	});

	const runDue = Effect.fn('Indexing.runDue')(function* (limit: number) {
		const bounded = Math.max(1, Math.min(limit, 10));
		const now = new Date().toISOString();
		const includeDisabled = embedder.enabled && vectors.enabled;
		const rows = yield* sql<{ id: string }>`
			SELECT id
			FROM files
			WHERE org_id = ${org.id}
				AND deleted_at IS NULL
				AND (expires_at IS NULL OR expires_at > ${now})
				AND index_attempts < ${MAX_INDEX_ATTEMPTS}
				AND (
					(index_state = 'pending'
						AND (index_next_run_at IS NULL OR index_next_run_at <= ${now}))
					OR (index_state = 'running' AND index_next_run_at <= ${now})
					OR (index_state = 'disabled' AND ${includeDisabled}::boolean)
				)
			ORDER BY COALESCE(index_next_run_at, updated_at), id
			LIMIT ${bounded}`.pipe(Effect.mapError(storage('list due indexing jobs')));
		for (const row of rows) yield* process(row.id);
		return rows.length;
	});

	const enqueue = Effect.fn('Indexing.enqueue')(function* (fileId: string) {
		yield* sql`
			UPDATE files
			SET index_state = 'pending', index_cursor = 0, index_attempts = 0,
				index_error = NULL, index_next_run_at = NULL,
				index_lease_token = NULL
			WHERE id = ${fileId} AND org_id = ${org.id} AND deleted_at IS NULL
				AND (expires_at IS NULL OR expires_at > ${new Date().toISOString()})`.pipe(
			Effect.mapError(storage('enqueue semantic indexing'))
		);
	});

	const status = Effect.gen(function* () {
		const enabled = embedder.enabled && vectors.enabled;
		const cached = semanticStatusCache.get(org.id);
		if (cached) return { ...cached, enabled };
		const indexedChunks = yield* vectors.count(org.id);
		const result = {
			enabled,
			indexedChunks,
			dimensions: 384,
			model: EMBEDDING_MODEL,
			costNotice:
				'Embeddings are stored in Postgres (pgvector) beside the file rows; each indexed chunk costs 384 floats plus its HNSW index entry, and keyword search stays available when semantic search is off.'
		};
		semanticStatusCache.set(org.id, result);
		return result;
	}).pipe(Effect.withSpan('Indexing.status'));

	return Indexing.of({ enqueue, process, runDue, status });
});

export const IndexingLive = Layer.effect(Indexing, makeIndexing);
