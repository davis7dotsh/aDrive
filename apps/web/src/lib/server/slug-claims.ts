import type { PgClient } from '@effect/sql-pg';

// Call inside the transaction before reading live or parked slug claims.
// Org creation and renaming share this namespace (ASCII "slug"). Keep the
// lock in its own statement so a waiter reads a fresh snapshot afterward.
export const lockSlugClaims = (sql: PgClient.PgClient) =>
	sql`SELECT pg_advisory_xact_lock(1936487783, 0)`;
