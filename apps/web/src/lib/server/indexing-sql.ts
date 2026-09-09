import type { PgClient } from '@effect/sql-pg';
import { Data, Effect } from 'effect';
import { refreshSearchDocument } from './search-index';

export interface IndexLease {
	readonly orgId: string;
	readonly fileId: string;
	readonly version: number;
	readonly attempt: number;
	readonly token: string;
}

export interface IndexFailure {
	readonly state: 'pending' | 'failed';
	readonly error: string;
	readonly nextRunAt: string | null;
}

export interface VectorChunk {
	readonly fileId: string;
	readonly version: number;
	readonly ordinal: number;
	readonly charStart: number;
	readonly charEnd: number;
	readonly values: ReadonlyArray<number>;
}

// Raised inside a transaction when the claimed lease no longer holds; the
// transaction rolls back and the caller sees `false` instead of an error.
class StaleIndexLease extends Data.TaggedError('StaleIndexLease')<{}> {}

const staleAsFalse = <E, R>(
	effect: Effect.Effect<unknown, E | StaleIndexLease, R>
) =>
	effect.pipe(
		Effect.as(true),
		Effect.catchTag('StaleIndexLease', () => Effect.succeed(false))
	);

// Locks the files row for the rest of the transaction so a concurrent
// claim for a newer version waits for this commit instead of interleaving.
const holdLease = (sql: PgClient.PgClient, lease: IndexLease) =>
	sql<{ held: number }>`
		SELECT 1 AS held FROM files
		WHERE id = ${lease.fileId} AND org_id = ${lease.orgId}
			AND current_version = ${lease.version}
			AND index_state = 'running' AND index_lease_token = ${lease.token}
		FOR UPDATE`.pipe(
		Effect.flatMap((rows) =>
			rows.length === 1 ? Effect.void : new StaleIndexLease()
		)
	);

const leaseUpdateFilter = (sql: PgClient.PgClient, lease: IndexLease) =>
	sql`id = ${lease.fileId} AND org_id = ${lease.orgId}
		AND current_version = ${lease.version}
		AND index_state = 'running' AND index_lease_token = ${lease.token}`;

export const claimIndex = (
	sql: PgClient.PgClient,
	lease: IndexLease,
	now: string,
	leaseUntil: string,
	maxAttempts: number
) =>
	sql<{ id: string }>`
		UPDATE files
		SET index_state = 'running', index_attempts = index_attempts + 1,
			index_error = NULL, index_next_run_at = ${leaseUntil},
			index_lease_token = ${lease.token}
		WHERE id = ${lease.fileId} AND org_id = ${lease.orgId}
			AND current_version = ${lease.version}
			AND deleted_at IS NULL
			AND (expires_at IS NULL OR expires_at > ${now})
			AND index_attempts = ${lease.attempt - 1}
			AND index_attempts < ${maxAttempts}
			AND (
				index_state IN ('pending', 'disabled')
				OR (index_state = 'running' AND index_next_run_at <= ${now})
			)
		RETURNING id`.pipe(Effect.map((rows) => rows.length === 1));

// Stores the extracted text for the leased version and refreshes the
// keyword document from it. index_cursor = 1 marks the text as stored so a
// retried attempt skips the R2 read.
export const storeExtractedText = (
	sql: PgClient.PgClient,
	lease: IndexLease,
	text: string
) =>
	sql
		.withTransaction(
			Effect.gen(function* () {
				yield* holdLease(sql, lease);
				// PostgreSQL text rejects NUL bytes; match the semantic chunker's
				// cleanup before writing either the source text or keyword index.
				yield* sql`
					UPDATE file_versions SET text_content = ${text.replaceAll('\u0000', '')}
					WHERE file_id = ${lease.fileId} AND org_id = ${lease.orgId}
						AND version = ${lease.version}`;
				yield* sql`
					UPDATE files SET index_cursor = 1
					WHERE ${leaseUpdateFilter(sql, lease)}`;
				yield* refreshSearchDocument(sql, lease.fileId, lease.orgId);
			})
		)
		.pipe(staleAsFalse);

export const finishKeywordOnly = (sql: PgClient.PgClient, lease: IndexLease) =>
	sql<{ id: string }>`
		UPDATE files
		SET index_state = 'disabled', indexed_version = NULL,
			index_attempts = 0, index_error = NULL,
			index_next_run_at = NULL, index_lease_token = NULL
		WHERE ${leaseUpdateFilter(sql, lease)}
		RETURNING id`.pipe(Effect.map((rows) => rows.length === 1));

// One multi-row statement: the columns arrive as parallel arrays and are
// zipped by unnest, and the embeddings travel in pgvector's text form. The
// org comes from the file row so a chunk can never land in another org.
export const upsertFileChunks = (
	sql: PgClient.PgClient,
	rows: ReadonlyArray<VectorChunk>
) =>
	rows.length === 0
		? Effect.void
		: sql`
			INSERT INTO file_chunks (
				file_id, version, ordinal, char_start, char_end, embedding, org_id
			)
			SELECT u.file_id, u.version, u.ordinal, u.char_start, u.char_end,
				u.embedding, f.org_id
			FROM unnest(
				${rows.map((row) => row.fileId)}::text[],
				${rows.map((row) => row.version)}::integer[],
				${rows.map((row) => row.ordinal)}::integer[],
				${rows.map((row) => row.charStart)}::integer[],
				${rows.map((row) => row.charEnd)}::integer[],
				${rows.map((row) => `[${row.values.join(',')}]`)}::vector[]
			) AS u(file_id, version, ordinal, char_start, char_end, embedding)
			JOIN files f ON f.id = u.file_id
			ON CONFLICT (file_id, version, ordinal) DO UPDATE
			SET char_start = EXCLUDED.char_start,
				char_end = EXCLUDED.char_end,
				embedding = EXCLUDED.embedding`.pipe(Effect.asVoid);

// Commits the embedded chunks and the ready state together. Chunks from
// older versions (and any same-version ordinals past the new count) go in
// the same transaction, so a stale lease rolls everything back and the
// newer version's rows are never touched.
export const semanticCommit = (
	sql: PgClient.PgClient,
	lease: IndexLease,
	chunks: ReadonlyArray<VectorChunk>
) =>
	sql
		.withTransaction(
			Effect.gen(function* () {
				yield* holdLease(sql, lease);
				yield* sql`
					DELETE FROM file_chunks
					WHERE file_id = ${lease.fileId} AND org_id = ${lease.orgId}
						AND (version <> ${lease.version} OR ordinal >= ${chunks.length})`;
				yield* upsertFileChunks(sql, chunks);
				const updated = yield* sql<{ id: string }>`
					UPDATE files
					SET index_state = 'ready', indexed_version = ${lease.version},
						index_cursor = ${chunks.length}, index_attempts = 0,
						index_error = NULL, index_next_run_at = NULL,
						index_lease_token = NULL
					WHERE ${leaseUpdateFilter(sql, lease)}
					RETURNING id`;
				if (updated.length !== 1) return yield* new StaleIndexLease();
			})
		)
		.pipe(staleAsFalse);

// Chunks are only written inside semanticCommit, so a failed attempt has
// nothing to clean up; recording the disposition releases the lease.
export const recordIndexFailure = (
	sql: PgClient.PgClient,
	lease: IndexLease,
	failure: IndexFailure
) =>
	sql<{ id: string }>`
		UPDATE files
		SET index_state = ${failure.state}, index_error = ${failure.error},
			index_next_run_at = ${failure.nextRunAt}, index_lease_token = NULL
		WHERE ${leaseUpdateFilter(sql, lease)}
		RETURNING id`.pipe(Effect.map((rows) => rows.length === 1));
