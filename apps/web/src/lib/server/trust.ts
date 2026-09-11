import type { PgClient } from '@effect/sql-pg';
import { Effect } from 'effect';
import { InvalidRequest, StorageError } from './errors';
import {
	PUBLISH_BLOCKED_MESSAGE,
	canPublish,
	establishedCutoff,
	parseTrust,
	type TrustLevel
} from './trust-policy';

const storageError = (operation: string) =>
	Effect.mapError((cause: unknown) => new StorageError({ operation, cause }));

// The org's trust level, read fresh on every publish decision so an admin
// suspension or bump lands on the next request. Within a publication
// transaction the shared row lock keeps that decision stable until commit.
export const orgTrust = (sql: PgClient.PgClient, orgId: string) =>
	sql<{ trust: string }>`
		SELECT trust FROM orgs WHERE id = ${orgId} LIMIT 1 FOR SHARE
	`.pipe(
		Effect.map((rows): TrustLevel => parseTrust(rows[0]?.trust ?? 'new')),
		storageError('read org trust')
	);

// The gate in front of every path that makes content public. A `new` org
// gets a 403 that tells the member what unlocks it.
export const requirePublishAllowed = (sql: PgClient.PgClient, orgId: string) =>
	Effect.gen(function* () {
		const trust = yield* orgTrust(sql, orgId);
		if (!canPublish(trust)) {
			return yield* new InvalidRequest({
				status: 403,
				message: PUBLISH_BLOCKED_MESSAGE
			});
		}
		return trust;
	});

// Sign-in with a verified email moves the org out of `new`. Never touches
// any other level: a suspension survives a sign-in.
export const promoteVerified = (sql: PgClient.PgClient, orgId: string) =>
	sql`
		UPDATE orgs SET trust = 'verified'
		WHERE id = ${orgId} AND trust = 'new'
	`.pipe(Effect.asVoid, storageError('promote org to verified'));

// Maintenance sweep: verified orgs over 14 days old and currently on a
// paid plan become established. Returns how many were promoted.
export const promoteEstablished = (
	sql: PgClient.PgClient,
	now: Date,
	limit = 100
) =>
	sql<{ id: string }>`
		UPDATE orgs SET trust = 'established'
		WHERE id IN (
			SELECT id FROM orgs
			WHERE trust = 'verified' AND plan <> 'free'
				AND created_at < ${establishedCutoff(now)}
			ORDER BY created_at
			LIMIT ${Math.max(1, Math.min(limit, 1000))}
		)
		RETURNING id
	`.pipe(
		Effect.map((rows) => rows.length),
		storageError('promote orgs to established')
	);
