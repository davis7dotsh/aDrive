import type { PgClient } from '@effect/sql-pg';
import { ensureTenant, type TenantRows } from '../tenants';

export const TEST_ORG_ID = 'org_test';
export const TEST_USER_ID = 'user_test';

export const testTenant = (
	orgId = TEST_ORG_ID,
	userId = TEST_USER_ID
): TenantRows => ({
	orgId,
	userId,
	slug: orgId.replaceAll('_', '-'),
	name: `${orgId} drive`,
	email: `${userId}@example.test`,
	emailVerified: true
});

// Every *.pg.test.ts inserts tenant rows directly, so it upserts this
// fixed org first. Idempotent; the database is shared across test files.
export const ensureTestOrg = (sql: PgClient.PgClient) =>
	ensureTenant(sql, testTenant());
