import type { PgClient } from '@effect/sql-pg';
import { Effect } from 'effect';
import { StorageError } from './errors';
import { lockSlugClaims } from './slug-claims';
import { SLUG_MAX_LENGTH, SLUG_REDIRECT_WINDOW_MS } from './slug-policy';

export interface TenantRows {
	readonly orgId: string;
	readonly userId: string;
	readonly slug: string;
	readonly name: string;
	readonly email: string;
	readonly emailVerified?: boolean;
	readonly role?: string;
}

// Upserts the four rows a tenant needs before any tenant-scoped row can
// reference it: the org, the user, the membership, and the usage counter.
// Keep them atomic so a failed first sign-in cannot leave a membership
// that makes a retry skip the missing usage counter.
// Idempotent, and never rewinds a row that already exists (a later sign-in
// must not rename an org the owner renamed).
export const ensureTenant = (sql: PgClient.PgClient, tenant: TenantRows) =>
	sql.withTransaction(
		Effect.gen(function* () {
			yield* lockSlugClaims(sql);
			const existing = yield* sql<{ id: string }>`
				SELECT id FROM orgs WHERE id = ${tenant.orgId}
			`;
			if (existing.length === 0) {
				const redirectCutoff = new Date(
					Date.now() - SLUG_REDIRECT_WINDOW_MS
				).toISOString();
				const reserved = yield* sql<{ org_id: string }>`
					SELECT org_id FROM org_slug_history
					WHERE slug = ${tenant.slug} AND org_id <> ${tenant.orgId}
						AND released_at > ${redirectCutoff}
					LIMIT 1
				`;
				if (reserved.length > 0) {
					return yield* new StorageError({
						operation: 'create tenant',
						cause: 'The organization slug is reserved by another organization'
					});
				}
			}
			yield* sql`
			INSERT INTO orgs (id, slug, name)
			VALUES (${tenant.orgId}, ${tenant.slug}, ${tenant.name})
			ON CONFLICT (id) DO NOTHING`;
			yield* sql`
			INSERT INTO users (id, email, email_verified)
			VALUES (${tenant.userId}, ${tenant.email}, ${tenant.emailVerified ?? false})
			ON CONFLICT (id) DO UPDATE
			SET email = EXCLUDED.email, email_verified = EXCLUDED.email_verified`;
			yield* sql`
			INSERT INTO memberships (org_id, user_id, role)
			VALUES (${tenant.orgId}, ${tenant.userId}, ${tenant.role ?? 'owner'})
			ON CONFLICT (org_id, user_id) DO NOTHING`;
			yield* sql`
			INSERT INTO org_usage (org_id) VALUES (${tenant.orgId})
			ON CONFLICT (org_id) DO NOTHING`;
		})
	);

// First-login org naming keeps a readable email prefix and 64 random bits
// so common local parts have ample space without exceeding the slug limit.
export const slugify = (value: string) =>
	value
		.normalize('NFKD')
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, '-')
		.replace(/^-+|-+$/g, '')
		.slice(0, 40) || 'drive';

const randomHex = (bytes: number) => {
	const value = new Uint8Array(bytes);
	crypto.getRandomValues(value);
	return Array.from(value, (byte) => byte.toString(16).padStart(2, '0')).join(
		''
	);
};

export const personalOrgFor = (email: string) => {
	const local = email.split('@')[0] ?? email;
	const suffix = randomHex(8);
	return {
		name: `${local}'s drive`,
		slug: `${slugify(local)
			.slice(0, SLUG_MAX_LENGTH - suffix.length - 1)
			.replace(/-+$/, '')}-${suffix}`
	};
};
