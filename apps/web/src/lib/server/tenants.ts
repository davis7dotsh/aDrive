import type { PgClient } from '@effect/sql-pg';
import { Effect } from 'effect';

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
// Idempotent, and never rewinds a row that already exists (a later sign-in
// must not rename an org the owner renamed).
export const ensureTenant = (sql: PgClient.PgClient, tenant: TenantRows) =>
	Effect.gen(function* () {
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
	}).pipe(Effect.asVoid);

// First-login org naming. Stack C owns the real slug rules; until then the
// slug is the email's local part plus a short random suffix so two people
// named `sam` never collide.
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
	return {
		name: `${local}'s drive`,
		slug: `${slugify(local)}-${randomHex(2)}`
	};
};
