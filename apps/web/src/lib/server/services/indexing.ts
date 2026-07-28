import { Cause, Context, Effect, Layer, Schema } from 'effect';
import { StorageError } from '../errors';
import { fileIndexStatements } from '../search-index';
import {
	MAX_INDEX_ATTEMPTS,
	chunkSearchText,
	indexFailureDisposition,
	retryAt,
	safeIndexError,
	vectorIdForChunk
} from '../semantic-policy';
import { isSearchableText, searchTextLimit } from '../search-text';
import { Blobs } from './blobs';
import { Db } from './bindings';
import { Embedder, VectorIndex } from './semantic';

const INDEX_LEASE_MS = 5 * 60 * 1_000;
const EMBEDDING_MODEL = '@cf/baai/bge-small-en-v1.5';

const IndexJobRow = Schema.Struct({
	id: Schema.String,
	display_name: Schema.String,
	content_type: Schema.String,
	kind: Schema.String,
	current_version: Schema.Int,
	is_public: Schema.Int,
	r2_key: Schema.String,
	text_content: Schema.NullOr(Schema.String),
	index_state: Schema.String,
	index_cursor: Schema.Int,
	index_attempts: Schema.Int,
	index_next_run_at: Schema.NullOr(Schema.String)
});

const PendingVectorRow = Schema.Struct({
	vector_id: Schema.String,
	attempts: Schema.Int
});

const CountRow = Schema.Struct({
	count: Schema.Int
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
	readonly retryVectorDeletes: (
		limit: number
	) => Effect.Effect<number, StorageError>;
	readonly status: Effect.Effect<SemanticStatus, StorageError>;
}

export class Indexing extends Context.Service<Indexing, IndexingShape>()(
	'app/Indexing'
) {}

const makeIndexing = Effect.gen(function* () {
	const db = yield* Db;
	const blobs = yield* Blobs;
	const embedder = yield* Embedder;
	const vectors = yield* VectorIndex;

	const all = Effect.fn('Indexing.all')(function* <A, I>(
		statement: D1PreparedStatement,
		schema: Schema.Codec<A, I, never>,
		operation: string
	) {
		const rows = yield* Effect.tryPromise({
			try: async () => {
				const result = await statement.all();
				if (!result.success) throw new Error(result.error ?? operation);
				return result.results;
			},
			catch: (cause) => new StorageError({ operation, cause })
		});
		return decodeRows(schema, rows);
	});

	const findJob = Effect.fn('Indexing.findJob')(function* (fileId: string) {
		const rows = yield* all(
			db
				.prepare(
					`SELECT
						f.id, f.display_name, f.content_type, f.kind, f.current_version,
						f.public AS is_public, v.r2_key, v.text_content, f.index_state,
						f.index_cursor, f.index_attempts, f.index_next_run_at
					FROM files f
					JOIN file_versions v
						ON v.file_id = f.id AND v.version = f.current_version
					WHERE f.id = ? AND f.deleted_at IS NULL
						AND (f.expires_at IS NULL OR f.expires_at > ?)
					LIMIT 1`
				)
				.bind(fileId, new Date().toISOString()),
			IndexJobRow,
			'find indexing job'
		);
		return rows[0] ?? null;
	});

	const markFailure = Effect.fn('Indexing.markFailure')(function* (
		fileId: string,
		cause: unknown
	) {
		const row = yield* findJob(fileId);
		if (!row) return;
		const disposition = indexFailureDisposition(row.index_attempts);
		const error = safeIndexError(cause);
		yield* Effect.tryPromise({
			try: () =>
				db
					.prepare(
						`UPDATE files
						SET index_state = ?, index_error = ?, index_next_run_at = ?
						WHERE id = ? AND index_state = 'running'`
					)
					.bind(disposition.state, error, disposition.nextRunAt, fileId)
					.run(),
			catch: (failure) =>
				new StorageError({
					operation: 'record indexing failure',
					cause: failure
				})
		});
		console.error(
			JSON.stringify({
				message:
					disposition.state === 'failed'
						? 'semantic indexing reached its retry limit'
						: 'semantic indexing will retry',
				fileId,
				attempt: row.index_attempts,
				error
			})
		);
	});

	const retryVectorDeletes = Effect.fn('Indexing.retryVectorDeletes')(
		function* (limit: number) {
			if (!vectors.enabled) return 0;
			const bounded = Math.max(1, Math.min(limit, 100));
			const now = new Date().toISOString();
			const rows = yield* all(
				db
					.prepare(
						`SELECT vector_id, attempts
						FROM pending_vector_deletes
						WHERE next_run_at IS NULL OR next_run_at <= ?
						ORDER BY queued_at, vector_id
						LIMIT ?`
					)
					.bind(now, bounded),
				PendingVectorRow,
				'list pending vector deletes'
			);
			if (rows.length === 0) return 0;
			const ids = rows.map((row) => row.vector_id);
			const removed = yield* vectors.remove(ids).pipe(
				Effect.as(true),
				Effect.catch((failure) =>
					Effect.tryPromise({
						try: () =>
							db.batch(
								rows.map((row) =>
									db
										.prepare(
											`UPDATE pending_vector_deletes
											SET attempts = attempts + 1, last_error = ?,
												next_run_at = ?
											WHERE vector_id = ?`
										)
										.bind(
											safeIndexError(failure.cause),
											retryAt(row.attempts + 1),
											row.vector_id
										)
								)
							),
						catch: (cause) =>
							new StorageError({
								operation: 'record vector cleanup failure',
								cause
							})
					}).pipe(Effect.as(false))
				)
			);
			if (!removed) return 0;
			yield* Effect.tryPromise({
				try: () =>
					db.batch(
						ids.map((id) =>
							db
								.prepare(
									'DELETE FROM pending_vector_deletes WHERE vector_id = ?'
								)
								.bind(id)
						)
					),
				catch: (cause) =>
					new StorageError({
						operation: 'finish vector cleanup',
						cause
					})
			});
			return ids.length;
		}
	);

	const perform = Effect.fn('Indexing.perform')(function* (fileId: string) {
		const initial = yield* findJob(fileId);
		if (!initial) return;
		const now = new Date();
		const leaseUntil = new Date(now.getTime() + INDEX_LEASE_MS).toISOString();
		const claim = yield* Effect.tryPromise({
			try: () =>
				db
					.prepare(
						`UPDATE files
						SET index_state = 'running', index_attempts = index_attempts + 1,
							index_error = NULL, index_next_run_at = ?
						WHERE id = ? AND current_version = ? AND deleted_at IS NULL
							AND (expires_at IS NULL OR expires_at > ?)
							AND index_attempts < ?
							AND (
								index_state IN ('pending', 'disabled')
								OR (index_state = 'running' AND index_next_run_at <= ?)
							)`
					)
					.bind(
						leaseUntil,
						fileId,
						initial.current_version,
						now.toISOString(),
						MAX_INDEX_ATTEMPTS,
						now.toISOString()
					)
					.run(),
			catch: (cause) =>
				new StorageError({ operation: 'claim indexing job', cause })
		});
		if (claim.meta.changes !== 1) return;

		const text =
			initial.index_cursor >= 1 && initial.text_content !== null
				? initial.text_content
				: initial.kind === 'file' &&
					  isSearchableText(initial.display_name, initial.content_type)
					? yield* blobs.readTextPrefix(initial.r2_key, searchTextLimit)
					: '';

		yield* Effect.tryPromise({
			try: () =>
				db.batch([
					db
						.prepare(
							`UPDATE file_versions SET text_content = ?
							WHERE file_id = ? AND version = ?`
						)
						.bind(text, fileId, initial.current_version),
					db
						.prepare(
							`UPDATE files SET index_cursor = 1
							WHERE id = ? AND current_version = ? AND index_state = 'running'`
						)
						.bind(fileId, initial.current_version),
					...fileIndexStatements(db, fileId)
				]),
			catch: (cause) =>
				new StorageError({ operation: 'store extracted search text', cause })
		});

		if (!embedder.enabled || !vectors.enabled) {
			yield* Effect.tryPromise({
				try: () =>
					db
						.prepare(
							`UPDATE files
							SET index_state = 'disabled', indexed_version = NULL,
								index_attempts = 0, index_error = NULL,
								index_next_run_at = NULL
							WHERE id = ? AND current_version = ? AND index_state = 'running'`
						)
						.bind(fileId, initial.current_version)
						.run(),
				catch: (cause) =>
					new StorageError({
						operation: 'finish keyword-only indexing',
						cause
					})
			});
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

		const vectorRecords = chunks.map((chunk, index) => ({
			id: vectorIdForChunk(fileId, initial.current_version, chunk.ordinal),
			values: embeddings[index] ?? [],
			metadata: {
				fileId,
				version: initial.current_version,
				deleted: false,
				kind: initial.kind,
				visibility: initial.is_public === 1 ? 'public' : 'private'
			}
		}));
		yield* vectors.upsert(vectorRecords);

		const indexedAt = new Date().toISOString();
		const statements = [
			db
				.prepare(
					`INSERT INTO pending_vector_deletes (vector_id, queued_at)
					SELECT vector_id, ? FROM file_chunks
					WHERE file_id = ? AND version <> ?
					ON CONFLICT(vector_id) DO NOTHING`
				)
				.bind(indexedAt, fileId, initial.current_version),
			db.prepare('DELETE FROM file_chunks WHERE file_id = ?').bind(fileId),
			...chunks.map((chunk) =>
				db
					.prepare(
						`INSERT INTO file_chunks (
							vector_id, file_id, version, ordinal, char_start, char_end
						) VALUES (?, ?, ?, ?, ?, ?)`
					)
					.bind(
						vectorIdForChunk(fileId, initial.current_version, chunk.ordinal),
						fileId,
						initial.current_version,
						chunk.ordinal,
						chunk.charStart,
						chunk.charEnd
					)
			),
			db
				.prepare(
					`UPDATE files
					SET index_state = 'ready', indexed_version = ?, index_cursor = ?,
						index_attempts = 0, index_error = NULL, index_next_run_at = NULL
					WHERE id = ? AND current_version = ? AND index_state = 'running'`
				)
				.bind(
					initial.current_version,
					chunks.length,
					fileId,
					initial.current_version
				)
		];
		yield* Effect.tryPromise({
			try: () => db.batch(statements),
			catch: (cause) =>
				new StorageError({ operation: 'commit semantic index state', cause })
		});
		yield* retryVectorDeletes(100).pipe(
			Effect.catchCause((cause) =>
				Effect.sync(() => {
					console.error(
						JSON.stringify({
							message: 'vector cleanup remains pending',
							fileId,
							cause: String(cause)
						})
					);
				})
			)
		);
	});

	const process = Effect.fn('Indexing.process')(function* (fileId: string) {
		yield* perform(fileId).pipe(
			Effect.catchCause((cause) =>
				markFailure(fileId, Cause.pretty(cause)).pipe(
					Effect.catchCause((recordCause) =>
						Effect.sync(() => {
							console.error(
								JSON.stringify({
									message: 'could not persist indexing failure',
									fileId,
									cause: String(recordCause)
								})
							);
						})
					)
				)
			)
		);
	});

	const runDue = Effect.fn('Indexing.runDue')(function* (limit: number) {
		const bounded = Math.max(1, Math.min(limit, 10));
		const now = new Date().toISOString();
		const includeDisabled = embedder.enabled && vectors.enabled ? 1 : 0;
		const rows = yield* Effect.tryPromise({
			try: async () => {
				const result = await db
					.prepare(
						`SELECT id
						FROM files
						WHERE deleted_at IS NULL
							AND (expires_at IS NULL OR expires_at > ?)
							AND index_attempts < ?
							AND (
								(index_state = 'pending'
									AND (index_next_run_at IS NULL OR index_next_run_at <= ?))
								OR (index_state = 'running' AND index_next_run_at <= ?)
								OR (index_state = 'disabled' AND ? = 1)
							)
						ORDER BY COALESCE(index_next_run_at, updated_at), id
						LIMIT ?`
					)
					.bind(now, MAX_INDEX_ATTEMPTS, now, now, includeDisabled, bounded)
					.all<{ id: string }>();
				if (!result.success)
					throw new Error(result.error ?? 'Index job listing failed');
				return result.results;
			},
			catch: (cause) =>
				new StorageError({ operation: 'list due indexing jobs', cause })
		});
		for (const row of rows) yield* process(row.id);
		return rows.length;
	});

	const enqueue = Effect.fn('Indexing.enqueue')(function* (fileId: string) {
		yield* Effect.tryPromise({
			try: () =>
				db
					.prepare(
						`UPDATE files
						SET index_state = 'pending', index_cursor = 0, index_attempts = 0,
							index_error = NULL, index_next_run_at = NULL
						WHERE id = ? AND deleted_at IS NULL
							AND (expires_at IS NULL OR expires_at > ?)`
					)
					.bind(fileId, new Date().toISOString())
					.run(),
			catch: (cause) =>
				new StorageError({ operation: 'enqueue semantic indexing', cause })
		});
	});

	const status = Effect.gen(function* () {
		const rows = yield* all(
			db.prepare('SELECT COUNT(*) AS count FROM file_chunks'),
			CountRow,
			'count indexed chunks'
		);
		return {
			enabled: embedder.enabled && vectors.enabled,
			indexedChunks: rows[0]?.count ?? 0,
			dimensions: 384,
			model: EMBEDDING_MODEL,
			costNotice:
				'Vectorize bills each query against stored vectors × 384 dimensions; keyword search stays available when semantic search is off.'
		};
	}).pipe(Effect.withSpan('Indexing.status'));

	return Indexing.of({
		enqueue,
		process,
		runDue,
		retryVectorDeletes,
		status
	});
});

export const IndexingLive = Layer.effect(Indexing, makeIndexing);
