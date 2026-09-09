import type { PgClient } from '@effect/sql-pg';
import { Effect } from 'effect';
import { InvalidRequest, StorageError } from './errors';
import { planLimits } from './plans';

// Stored bytes are metered per org in org_usage.stored_bytes, moved by
// the same transaction that creates or drops the rows they describe:
// file uploads, version restores, site commits, thumbnail replacement,
// and purges. The reservation is a conditional UPDATE, so two concurrent
// uploads cannot both squeeze under the limit. Assets staged into an
// uncommitted site session are not counted; the manifest is bounded by
// the per-upload cap and the session expires on its own.

const exhausted = () =>
	new InvalidRequest({
		status: 413,
		message: 'The storage quota is exhausted'
	});

const missingUsage = (operation: string) =>
	new StorageError({
		operation,
		cause: 'The organization has no usage row'
	});

// The plan's byte ceiling for one org.
export const storageLimit = Effect.fn('StorageQuota.limit')(function* (
	sql: PgClient.PgClient,
	orgId: string
) {
	const rows = yield* sql<{ plan: string }>`
		SELECT plan FROM orgs WHERE id = ${orgId}`;
	const row = rows[0];
	if (!row) {
		return yield* new StorageError({
			operation: 'read storage plan',
			cause: 'Organization not found'
		});
	}
	return planLimits(row.plan).storedBytes;
});

// Moves the counter by delta. A positive delta only lands when it fits
// under the limit (zero rows means over quota); a negative delta always
// lands and floors at zero. Resolves to the new total.
export const reserveStoredBytes = Effect.fn('StorageQuota.reserve')(function* (
	sql: PgClient.PgClient,
	orgId: string,
	delta: number,
	limit: number
) {
	const rows = yield* sql<{ stored_bytes: number }>`
		UPDATE org_usage
		SET stored_bytes = GREATEST(0, stored_bytes + ${delta})
		WHERE org_id = ${orgId}
			AND (${delta}::bigint <= 0 OR stored_bytes + ${delta} <= ${limit})
		RETURNING stored_bytes`;
	const row = rows[0];
	if (row) return row.stored_bytes;
	if (delta <= 0) return yield* missingUsage('release stored bytes');
	const existing = yield* sql<{ stored_bytes: number }>`
		SELECT stored_bytes FROM org_usage WHERE org_id = ${orgId}`;
	if (existing.length === 1) return yield* exhausted();
	return yield* missingUsage('reserve stored bytes');
});

export const reserveWithinPlan = Effect.fn('StorageQuota.reserveWithinPlan')(
	function* (sql: PgClient.PgClient, orgId: string, delta: number) {
		const limit = yield* storageLimit(sql, orgId);
		return yield* reserveStoredBytes(sql, orgId, delta, limit);
	}
);

export const releaseStoredBytes = Effect.fn('StorageQuota.release')(function* (
	sql: PgClient.PgClient,
	orgId: string,
	bytes: number
) {
	const rows = yield* sql<{ stored_bytes: number }>`
		UPDATE org_usage
		SET stored_bytes = GREATEST(0, stored_bytes - ${Math.max(0, bytes)})
		WHERE org_id = ${orgId}
		RETURNING stored_bytes`;
	if (rows.length !== 1) return yield* missingUsage('release stored bytes');
});

// Read-only check before a body is accepted, so a client is refused up
// front instead of streaming bytes the commit would reject. The commit's
// reservation stays authoritative.
export const ensureStorageHeadroom = Effect.fn('StorageQuota.headroom')(
	function* (sql: PgClient.PgClient, orgId: string, incomingBytes: number) {
		const rows = yield* sql<{ stored_bytes: number; plan: string }>`
			SELECT u.stored_bytes, o.plan
			FROM org_usage u
			JOIN orgs o ON o.id = u.org_id
			WHERE u.org_id = ${orgId}`.pipe(
			Effect.mapError(
				(cause) =>
					new StorageError({ operation: 'measure stored bytes', cause })
			)
		);
		const row = rows[0];
		if (!row) return yield* missingUsage('measure stored bytes');
		if (row.stored_bytes + incomingBytes > planLimits(row.plan).storedBytes) {
			return yield* exhausted();
		}
	}
);
