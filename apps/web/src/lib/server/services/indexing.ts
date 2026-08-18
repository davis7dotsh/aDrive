import { Cause, Context, Effect, Layer, Schema } from 'effect';
import { StorageError } from '../errors';
import {
	claimIndexCommand,
	extractedTextCommands,
	finishKeywordOnlyCommand,
	indexFailureCommands,
	semanticCommitCommands,
	type IndexLease,
	type SqlCommand,
	vectorDeleteFailureCommand,
	vectorDeleteSuccessCommand
} from '../indexing-sql';
import {
	MAX_INDEX_ATTEMPTS,
	chunkSearchText,
	indexFailureDisposition,
	newIndexLeaseToken,
	retryAt,
	safeIndexError,
	vectorIdForChunk
} from '../semantic-policy';
import { isSearchableText, searchTextLimit } from '../search-text';
import { createObjectTtlCache } from '../isolate-cache';
import { Blobs } from './blobs';
import { Db } from './bindings';
import { Embedder, VectorIndex } from './semantic';

const INDEX_LEASE_MS = 5 * 60 * 1_000;
const EMBEDDING_MODEL = '@cf/baai/bge-small-en-v1.5';
const SEMANTIC_STATUS_CACHE_TTL_MS = 10_000;
const semanticStatusCache = createObjectTtlCache<D1Database, SemanticStatus>(
	SEMANTIC_STATUS_CACHE_TTL_MS
);

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

	const prepareCommand = (command: SqlCommand) =>
		db.prepare(command.sql).bind(...command.bindings);

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
		lease: IndexLease,
		vectorIds: ReadonlyArray<string>,
		cause: unknown
	) {
		const disposition = indexFailureDisposition(lease.attempt);
		const error = safeIndexError(cause);
		const commands = indexFailureCommands(
			lease,
			vectorIds,
			{ ...disposition, error },
			new Date().toISOString()
		);
		const results = yield* Effect.tryPromise({
			try: () => db.batch(commands.map(prepareCommand)),
			catch: (failure) =>
				new StorageError({
					operation: 'record indexing failure',
					cause: failure
				})
		});
		const stateChanged = results.at(-1)?.meta.changes === 1;
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
							prepareCommand(
								vectorDeleteFailureCommand(
									rows.map((row) => ({
										vectorId: row.vector_id,
										nextRunAt: retryAt(row.attempts + 1)
									})),
									safeIndexError(failure.cause)
								)
							).run(),
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
				try: () => prepareCommand(vectorDeleteSuccessCommand(ids)).run(),
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
		const lease = {
			fileId,
			version: initial.current_version,
			attempt: initial.index_attempts + 1,
			token: newIndexLeaseToken()
		} satisfies IndexLease;
		const claim = yield* Effect.tryPromise({
			try: () =>
				prepareCommand(
					claimIndexCommand(
						lease,
						now.toISOString(),
						leaseUntil,
						MAX_INDEX_ATTEMPTS
					)
				).run(),
			catch: (cause) =>
				new StorageError({ operation: 'claim indexing job', cause })
		});
		if (claim.meta.changes !== 1) return;

		let attemptVectorIds: ReadonlyArray<string> = [];
		yield* Effect.gen(function* () {
			const text =
				initial.index_cursor >= 1 && initial.text_content !== null
					? initial.text_content
					: initial.kind === 'file' &&
						  isSearchableText(initial.display_name, initial.content_type)
						? yield* blobs.readTextPrefix(initial.r2_key, searchTextLimit)
						: '';

			const extracted = yield* Effect.tryPromise({
				try: () =>
					db.batch(extractedTextCommands(lease, text).map(prepareCommand)),
				catch: (cause) =>
					new StorageError({
						operation: 'store extracted search text',
						cause
					})
			});
			if (extracted[1]?.meta.changes !== 1) {
				console.log(
					JSON.stringify({
						message: 'stale semantic extraction ignored',
						fileId,
						version: lease.version,
						attempt: lease.attempt
					})
				);
				return;
			}

			if (!embedder.enabled || !vectors.enabled) {
				const finished = yield* Effect.tryPromise({
					try: () => prepareCommand(finishKeywordOnlyCommand(lease)).run(),
					catch: (cause) =>
						new StorageError({
							operation: 'finish keyword-only indexing',
							cause
						})
				});
				if (finished.meta.changes !== 1) {
					console.log(
						JSON.stringify({
							message: 'stale keyword-only indexing completion ignored',
							fileId,
							version: lease.version,
							attempt: lease.attempt
						})
					);
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

			const vectorRecords = chunks.map((chunk, index) => ({
				id: vectorIdForChunk(fileId, lease.token, chunk.ordinal),
				values: embeddings[index] ?? [],
				metadata: {
					fileId,
					version: lease.version,
					deleted: false,
					kind: initial.kind,
					visibility: initial.is_public === 1 ? 'public' : 'private'
				}
			}));
			attemptVectorIds = vectorRecords.map((record) => record.id);
			yield* vectors.upsert(vectorRecords);

			const results = yield* Effect.tryPromise({
				try: () =>
					db.batch(
						semanticCommitCommands(
							lease,
							chunks,
							attemptVectorIds,
							new Date().toISOString()
						).map(prepareCommand)
					),
				catch: (cause) =>
					new StorageError({
						operation: 'commit semantic index state',
						cause
					})
			});
			if (results.at(-1)?.meta.changes !== 1) {
				console.log(
					JSON.stringify({
						message: 'stale semantic indexing completion cleaned up',
						fileId,
						version: lease.version,
						attempt: lease.attempt
					})
				);
			}

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
		}).pipe(
			Effect.catchCause((cause) =>
				markFailure(lease, attemptVectorIds, Cause.pretty(cause)).pipe(
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
							index_error = NULL, index_next_run_at = NULL,
							index_lease_token = NULL
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
		const cached = semanticStatusCache.get(db);
		if (cached) {
			return {
				...cached,
				enabled: embedder.enabled && vectors.enabled
			};
		}
		const rows = yield* all(
			db.prepare('SELECT COUNT(*) AS count FROM file_chunks'),
			CountRow,
			'count indexed chunks'
		);
		const result = {
			enabled: embedder.enabled && vectors.enabled,
			indexedChunks: rows[0]?.count ?? 0,
			dimensions: 384,
			model: EMBEDDING_MODEL,
			costNotice:
				'Vectorize bills each query against stored vectors × 384 dimensions; keyword search stays available when semantic search is off.'
		};
		semanticStatusCache.set(db, result);
		return result;
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
