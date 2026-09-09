import type { PgClient } from '@effect/sql-pg';
import { Cause, Effect } from 'effect';

// R2 cleanup after a failed commit is compensatable: when the delete
// itself fails the key goes to the durable lifecycle queue and a later
// sweep retries it. Idempotent on r2_key.
export const queueDeferredBlobDelete = (
	sql: PgClient.PgClient,
	r2Key: string,
	fileId: string,
	version: number,
	queuedAt: string,
	lastError: string
) =>
	sql`
		INSERT INTO pending_site_asset_deletes (
			r2_key, file_id, version, queued_at, attempts, last_error
		) VALUES (${r2Key}, ${fileId}, ${version}, ${queuedAt}, 1, ${lastError})
		ON CONFLICT (r2_key) DO NOTHING`.pipe(Effect.asVoid);

export const compensateBlobFailure = <
	OriginalError,
	DeleteError,
	DeleteRequirements,
	QueueError,
	QueueRequirements
>(
	failure: OriginalError,
	deleteBlob: Effect.Effect<void, DeleteError, DeleteRequirements>,
	queueDelete: (
		cause: Cause.Cause<DeleteError>
	) => Effect.Effect<void, QueueError, QueueRequirements>,
	onQueueFailure: (
		deleteCause: Cause.Cause<DeleteError>,
		queueCause: Cause.Cause<QueueError>
	) => void
) =>
	deleteBlob.pipe(
		Effect.catchCause((deleteCause) =>
			queueDelete(deleteCause).pipe(
				Effect.catchCause((queueCause) =>
					Effect.sync(() => onQueueFailure(deleteCause, queueCause))
				)
			)
		),
		Effect.andThen(Effect.fail(failure))
	);
