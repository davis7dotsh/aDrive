import { Cause, Effect } from 'effect';

export interface BlobDeleteSqlCommand {
	readonly sql: string;
	readonly bindings: ReadonlyArray<string | number>;
}

export const deferredBlobDeleteCommand = (
	r2Key: string,
	fileId: string,
	version: number,
	queuedAt: string,
	lastError: string
): BlobDeleteSqlCommand => ({
	sql: `INSERT INTO pending_site_asset_deletes (
			r2_key, file_id, version, queued_at, attempts, last_error
		) VALUES (?, ?, ?, ?, 1, ?)
		ON CONFLICT(r2_key) DO NOTHING`,
	bindings: [r2Key, fileId, version, queuedAt, lastError]
});

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
