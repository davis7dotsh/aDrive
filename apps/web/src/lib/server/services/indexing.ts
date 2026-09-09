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
import { stuckBefore } from '../job-policy';
import { PgSql } from '../pg';
import { Blobs } from './blobs';
import { CurrentOrg } from './current-org';
import { JobQueue } from './jobs';
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

// What one indexing attempt did. `retry` is the only outcome that asks
// the queue to deliver the job again; a permanent failure is already
// recorded on the row and a skipped job has nothing left to do.
export type IndexOutcome = 'indexed' | 'skipped' | 'retry' | 'failed';

export interface IndexingShape {
	// Resets the row and sends an index job for its current version.
	readonly enqueue: (fileId: string) => Effect.Effect<void, StorageError>;
	// One attempt for the current version, errors recorded on the row.
	readonly process: (fileId: string) => Effect.Effect<void, StorageError>;
	// The queue consumer's entry point: skips when `version` is no longer
	// current so a stale delivery never overwrites a newer index.
	readonly runOne: (job: {
		readonly fileId: string;
		readonly version: number;
	}) => Effect.Effect<IndexOutcome, StorageError>;
	// Reconciliation: re-sends jobs for rows stuck past their lease or
	// retry time, never indexes inline. Returns how many were re-sent.
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
	const jobs = yield* JobQueue;

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
		if (!stateChanged) return 'skipped' as const;
		return disposition.state === 'failed'
			? ('failed' as const)
			: ('retry' as const);
	});

	const perform = Effect.fn('Indexing.perform')(function* (
		fileId: string,
		expectedVersion: number | null
	) {
		const initial = yield* findJob(fileId);
		if (!initial) return 'skipped' as const;
		if (
			expectedVersion !== null &&
			initial.current_version !== expectedVersion
		) {
			console.log(
				JSON.stringify({
					message: 'stale index job skipped',
					fileId,
					version: expectedVersion,
					currentVersion: initial.current_version
				})
			);
			return 'skipped' as const;
		}
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
		if (!claimed) return 'skipped' as const;

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

		return yield* Effect.gen(function* () {
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
				yield* stale('stale semantic extraction ignored');
				return 'skipped' as const;
			}

			if (!embedder.enabled || !vectors.enabled) {
				const finished = yield* finishKeywordOnly(sql, lease).pipe(
					Effect.mapError(storage('finish keyword-only indexing'))
				);
				if (!finished) {
					yield* stale('stale keyword-only indexing completion ignored');
					return 'skipped' as const;
				}
				return 'indexed' as const;
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
				return 'skipped' as const;
			}
			return 'indexed' as const;
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
							// The lease still holds; the row is picked up again once
							// it lapses, so the delivery itself is not retried.
							return 'skipped' as const;
						})
					)
				)
			)
		);
	});

	const process = Effect.fn('Indexing.process')(function* (fileId: string) {
		yield* perform(fileId, null).pipe(
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

	const runOne = Effect.fn('Indexing.runOne')(function* (job: {
		readonly fileId: string;
		readonly version: number;
	}) {
		return yield* perform(job.fileId, job.version);
	});

	const sendIndexJob = (fileId: string, version: number) =>
		jobs.trySend({ kind: 'index', orgId: org.id, fileId, version });

	// Rows still pending or leased long after they were due lost their
	// delivery somewhere (a crashed consumer, a queue outage during the
	// send); they get a fresh job. Stamping index_next_run_at throttles
	// the re-send to once per stuck window and keeps a lapsed `running`
	// lease claimable. Disabled rows are re-sent once semantic search is
	// switched on so they gain embeddings.
	const runDue = Effect.fn('Indexing.runDue')(function* (limit: number) {
		const bounded = Math.max(1, Math.min(limit, 10));
		const now = new Date();
		const cutoff = stuckBefore(now.getTime());
		const includeDisabled = embedder.enabled && vectors.enabled;
		const rows = yield* sql<{ id: string; current_version: number }>`
			UPDATE files
			SET index_next_run_at = ${now.toISOString()}
			WHERE id IN (
				SELECT id
				FROM files
				WHERE org_id = ${org.id}
					AND deleted_at IS NULL
					AND (expires_at IS NULL OR expires_at > ${now.toISOString()})
					AND index_attempts < ${MAX_INDEX_ATTEMPTS}
					AND (
						(index_state IN ('pending', 'running')
							AND COALESCE(index_next_run_at, updated_at) <= ${cutoff})
						OR (index_state = 'disabled' AND ${includeDisabled}::boolean
							AND COALESCE(index_next_run_at, updated_at) <= ${cutoff})
					)
				ORDER BY COALESCE(index_next_run_at, updated_at), id
				LIMIT ${bounded}
			) AND org_id = ${org.id}
			RETURNING id, current_version`.pipe(
			Effect.mapError(storage('list stuck indexing jobs'))
		);
		for (const row of rows) yield* sendIndexJob(row.id, row.current_version);
		return rows.length;
	});

	const enqueue = Effect.fn('Indexing.enqueue')(function* (fileId: string) {
		const rows = yield* sql<{ current_version: number }>`
			UPDATE files
			SET index_state = 'pending', index_cursor = 0, index_attempts = 0,
				index_error = NULL, index_next_run_at = NULL,
				index_lease_token = NULL
			WHERE id = ${fileId} AND org_id = ${org.id} AND deleted_at IS NULL
				AND (expires_at IS NULL OR expires_at > ${new Date().toISOString()})
			RETURNING current_version`.pipe(
			Effect.mapError(storage('enqueue semantic indexing'))
		);
		const row = rows[0];
		if (row) yield* sendIndexJob(fileId, row.current_version);
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

	return Indexing.of({ enqueue, process, runOne, runDue, status });
});

export const IndexingLive = Layer.effect(Indexing, makeIndexing);
