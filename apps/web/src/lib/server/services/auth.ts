import { API_KEY_PATTERN, type ApiKey, type ApiKeyScope } from '@adrive/shared';
import { Context, Effect, Layer, Schema } from 'effect';
import {
	DEVICE_CODE_TTL_SECONDS,
	DEVICE_POLL_INTERVAL_SECONDS,
	normalizeApiKeyName,
	normalizeUserCode,
	shouldTouchLastUsed,
	validateExpiration
} from '../auth-policy';
import {
	InvalidRequest,
	StorageError,
	Unauthorized,
	validate
} from '../errors';
import type { AuthContext, ResolvedCredential } from '../identity';
import { PgSql } from '../pg';
import { ensureTenant, personalOrgFor } from '../tenants';
import { promoteVerified } from '../trust';
import { AutumnClient } from './autumn';
import { CurrentOrg, CurrentUser } from './current-org';
import { WorkOSClient } from './workos';

const ApiKeyRow = Schema.Struct({
	id: Schema.String,
	name: Schema.String,
	prefix: Schema.String,
	scope: Schema.Literals(['read-only', 'read-write']),
	secret_hash: Schema.String,
	created_at: Schema.String,
	expires_at: Schema.NullOr(Schema.String),
	last_used_at: Schema.NullOr(Schema.String),
	revoked_at: Schema.NullOr(Schema.String)
});

const MembershipRow = Schema.Struct({
	org_id: Schema.String,
	user_id: Schema.String,
	role: Schema.String,
	email: Schema.String,
	org_name: Schema.String,
	org_slug: Schema.String,
	org_trust: Schema.String
});

const ApiKeyCredentialRow = Schema.Struct({
	id: Schema.String,
	scope: Schema.Literals(['read-only', 'read-write']),
	secret_hash: Schema.String,
	expires_at: Schema.NullOr(Schema.String),
	last_used_at: Schema.NullOr(Schema.String),
	org_id: Schema.String,
	user_id: Schema.String,
	role: Schema.NullOr(Schema.String),
	email: Schema.NullOr(Schema.String),
	org_name: Schema.NullOr(Schema.String),
	org_slug: Schema.NullOr(Schema.String),
	org_trust: Schema.NullOr(Schema.String)
});

const DeviceCodeRow = Schema.Struct({
	device_code_hash: Schema.String,
	user_code: Schema.String,
	status: Schema.String,
	interval_seconds: Schema.Int,
	expires_at: Schema.String,
	last_polled_at: Schema.NullOr(Schema.String),
	name: Schema.String
});

export interface DeviceAuthorization {
	readonly deviceCode: string;
	readonly userCode: string;
	readonly expiresIn: number;
	readonly interval: number;
}

export type DevicePollResult =
	| { readonly status: 'authorization_pending' | 'slow_down' }
	| { readonly status: 'complete'; readonly apiKey: string };

export interface AuthShape {
	// Turns a presented credential into the identity the request acts as,
	// or Unauthorized when it is unknown, expired, or revoked. The handle
	// hook calls one of these once per request.
	readonly resolveApiKey: (
		bearer: string
	) => Effect.Effect<AuthContext, Unauthorized | StorageError>;
	readonly resolveSession: (
		sessionCookie: string
	) => Effect.Effect<ResolvedCredential, Unauthorized | StorageError>;
	// Exchanges the AuthKit callback code for a sealed session, bootstraps
	// a personal org on first sign-in, and mirrors the user, org, and
	// membership into Postgres. Returns the cookie value to set.
	readonly completeSignIn: (
		code: string
	) => Effect.Effect<
		{ readonly sealedSession: string },
		Unauthorized | StorageError
	>;
	readonly logoutUrl: (
		sessionCookie: string | undefined,
		returnTo: string
	) => Effect.Effect<string, StorageError>;
	// Webhook mirrors: WorkOS is the source of truth for accounts.
	readonly removeUser: (userId: string) => Effect.Effect<void, StorageError>;
	readonly removeMembership: (
		orgId: string,
		userId: string
	) => Effect.Effect<void, StorageError>;
	readonly listApiKeys: Effect.Effect<ReadonlyArray<ApiKey>, StorageError>;
	readonly createApiKey: (
		name: string,
		options?: {
			readonly scope?: ApiKeyScope;
			readonly expiresAt?: string | null;
		}
	) => Effect.Effect<
		{ readonly key: ApiKey; readonly token: string },
		InvalidRequest | StorageError
	>;
	readonly revokeApiKey: (
		id: string
	) => Effect.Effect<void, InvalidRequest | StorageError>;
	readonly createDeviceAuthorization: (
		name: string
	) => Effect.Effect<DeviceAuthorization, InvalidRequest | StorageError>;
	readonly approveDevice: (
		userCode: string
	) => Effect.Effect<void, InvalidRequest | StorageError>;
	readonly denyDevice: (
		userCode: string
	) => Effect.Effect<void, InvalidRequest | StorageError>;
	readonly pollDevice: (
		deviceCode: string
	) => Effect.Effect<
		DevicePollResult,
		InvalidRequest | Unauthorized | StorageError
	>;
	readonly sweepExpired: (limit: number) => Effect.Effect<number, StorageError>;
}

export class Auth extends Context.Service<Auth, AuthShape>()('app/Auth') {}

const parseUserCode = (value: string) =>
	Effect.try({
		try: () => normalizeUserCode(value),
		catch: (cause) =>
			cause instanceof InvalidRequest
				? cause
				: new InvalidRequest({
						status: 400,
						message: 'Device approval code is invalid'
					})
	});

const randomToken = (bytes = 32) => {
	const value = new Uint8Array(bytes);
	crypto.getRandomValues(value);
	return btoa(String.fromCharCode(...value))
		.replaceAll('+', '-')
		.replaceAll('/', '_')
		.replaceAll('=', '');
};

const randomHex = (bytes: number) => {
	const value = new Uint8Array(bytes);
	crypto.getRandomValues(value);
	return Array.from(value, (byte) => byte.toString(16).padStart(2, '0')).join(
		''
	);
};

const randomUserCode = () => {
	const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
	const bytes = new Uint8Array(8);
	crypto.getRandomValues(bytes);
	const value = Array.from(
		bytes,
		(byte) => alphabet[byte % alphabet.length]
	).join('');
	return `${value.slice(0, 4)}-${value.slice(4)}`;
};

const toHex = (bytes: ArrayBuffer) =>
	Array.from(new Uint8Array(bytes), (byte) =>
		byte.toString(16).padStart(2, '0')
	).join('');

const hexBytes = (value: string) => {
	const normalized = /^[0-9a-f]{64}$/i.test(value) ? value : '0'.repeat(64);
	return Uint8Array.from({ length: 32 }, (_, index) =>
		Number.parseInt(normalized.slice(index * 2, index * 2 + 2), 16)
	);
};

const constantTimeEqual = (left: Uint8Array, right: Uint8Array) => {
	let difference = left.length ^ right.length;
	for (let index = 0; index < left.length; index += 1) {
		difference |= left[index]! ^ (right[index] ?? 0);
	}
	return difference === 0;
};

const hashToken = (token: string) =>
	Effect.promise(() =>
		crypto.subtle.digest('SHA-256', new TextEncoder().encode(token))
	).pipe(Effect.map(toHex));

const decodeRows = <A, I>(schema: Schema.Codec<A, I, never>, rows: unknown) => {
	const decoded = Schema.decodeUnknownOption(Schema.Array(schema))(rows);
	return decoded._tag === 'Some' ? decoded.value : [];
};

const toApiKey = (row: typeof ApiKeyRow.Type): ApiKey => ({
	id: row.id,
	name: row.name,
	prefix: row.prefix,
	scope: row.scope,
	createdAt: row.created_at,
	expiresAt: row.expires_at,
	lastUsedAt: row.last_used_at,
	revokedAt: row.revoked_at
});

const invalidCredential = () =>
	new Unauthorized({ message: 'A valid credential is required' });

// The kill switch (services/admin.ts) stops every credential for the org.
const suspendedOrg = () =>
	new Unauthorized({ message: 'This organization is suspended' });

const makeAuth = Effect.gen(function* () {
	const sql = yield* PgSql;
	const workos = yield* WorkOSClient;
	const autumn = yield* AutumnClient;
	const org = yield* CurrentOrg;
	const user = yield* CurrentUser;

	const storageError = (operation: string) =>
		Effect.mapError((cause: unknown) => new StorageError({ operation, cause }));

	const membershipSelect = sql.literal(`
		SELECT m.org_id, m.user_id, m.role, u.email,
			o.name AS org_name, o.slug AS org_slug, o.trust AS org_trust
		FROM memberships m
		JOIN users u ON u.id = m.user_id
		JOIN orgs o ON o.id = m.org_id
	`);

	// The org a user acts in: the one on the session when WorkOS names it,
	// otherwise their first membership (a session created before the org
	// bootstrap, or a user WorkOS knows in one org without pinning it).
	const findMembership = Effect.fn('Auth.findMembership')(function* (
		userId: string,
		orgId: string | null
	) {
		const rows = yield* sql`
			${membershipSelect}
			WHERE ${sql.and([
				sql`m.user_id = ${userId}`,
				...(orgId === null ? [] : [sql`m.org_id = ${orgId}`])
			])}
			ORDER BY o.created_at, o.id
			LIMIT 1`.pipe(storageError('find membership'));
		return decodeRows(MembershipRow, rows)[0] ?? null;
	});

	const sessionContext = (
		sessionId: string,
		membership: typeof MembershipRow.Type
	): AuthContext => ({
		orgId: membership.org_id,
		userId: membership.user_id,
		role: membership.role,
		via: 'session',
		scope: 'read-write',
		credentialId: sessionId,
		email: membership.email,
		orgName: membership.org_name,
		orgSlug: membership.org_slug
	});

	const makeApiKey = Effect.fn('Auth.makeApiKey')(function* (name: string) {
		const normalizedName = yield* validate(() => normalizeApiKeyName(name));
		const prefix = randomHex(4);
		const token = `adr_${prefix}_${randomToken()}`;
		const secretHash = yield* hashToken(token);
		const id = crypto.randomUUID();
		const createdAt = new Date().toISOString();
		return {
			token,
			secretHash,
			row: {
				id,
				name: normalizedName,
				prefix,
				createdAt
			}
		};
	});

	const listApiKeys = Effect.gen(function* () {
		const rows = yield* sql`
			SELECT id, name, prefix, scope, secret_hash, created_at, expires_at,
				last_used_at, revoked_at
			FROM api_keys
			WHERE org_id = ${org.id}
			ORDER BY created_at DESC, id
		`.pipe(storageError('list API keys'));
		return decodeRows(ApiKeyRow, rows).map(toApiKey);
	}).pipe(Effect.withSpan('Auth.listApiKeys'));

	return Auth.of({
		// The prefix lookup is global (prefixes are unique across orgs); the
		// org and user the key acts as come from the key row itself.
		resolveApiKey: Effect.fn('Auth.resolveApiKey')(function* (bearer) {
			const match = API_KEY_PATTERN.exec(bearer);
			if (!match) return yield* invalidCredential();
			const rows = yield* sql`
				SELECT k.id, k.scope, k.secret_hash, k.expires_at, k.last_used_at,
					k.org_id, k.user_id, m.role, u.email,
					o.name AS org_name, o.slug AS org_slug, o.trust AS org_trust
				FROM api_keys k
				LEFT JOIN memberships m ON m.org_id = k.org_id AND m.user_id = k.user_id
				LEFT JOIN users u ON u.id = k.user_id
				LEFT JOIN orgs o ON o.id = k.org_id
				WHERE k.prefix = ${match[1]} AND k.revoked_at IS NULL
				LIMIT 1
			`.pipe(storageError('look up API key'));
			const row = decodeRows(ApiKeyCredentialRow, rows)[0];
			const actualHash = yield* hashToken(bearer);
			if (
				!row ||
				!constantTimeEqual(hexBytes(actualHash), hexBytes(row.secret_hash))
			) {
				return yield* invalidCredential();
			}
			const now = new Date();
			const nowIso = now.toISOString();
			if (row.expires_at !== null && row.expires_at <= nowIso) {
				return yield* new Unauthorized({
					message: 'This API key has expired'
				});
			}
			// A key whose owner left the org stops working with it.
			if (
				row.role === null ||
				row.email === null ||
				row.org_name === null ||
				row.org_slug === null
			) {
				return yield* new Unauthorized({
					message: 'This API key no longer belongs to an organization member'
				});
			}
			if (row.org_trust === 'suspended') return yield* suspendedOrg();
			if (shouldTouchLastUsed(row.last_used_at, now)) {
				yield* sql`
					UPDATE api_keys
					SET last_used_at = ${nowIso}
					WHERE id = ${row.id}
				`.pipe(storageError('update API key usage'));
			}
			return {
				orgId: row.org_id,
				userId: row.user_id,
				role: row.role,
				via: 'api-key' as const,
				scope: row.scope,
				credentialId: row.id,
				email: row.email,
				orgName: row.org_name,
				orgSlug: row.org_slug
			};
		}),
		// The access token inside the sealed cookie is verified locally
		// against WorkOS's JWKS; only an expired token costs an API call
		// (the refresh), whose new cookie travels back to the hook.
		resolveSession: Effect.fn('Auth.resolveSession')(function* (sessionCookie) {
			let loaded = yield* workos.loadSession(sessionCookie);
			let refreshedSession: string | null = null;
			if (!loaded.authenticated && loaded.refreshable) {
				refreshedSession = yield* workos.refresh(sessionCookie);
				if (refreshedSession === null) return yield* invalidCredential();
				loaded = yield* workos.loadSession(refreshedSession);
			}
			if (!loaded.authenticated) return yield* invalidCredential();
			const membership = yield* findMembership(loaded.userId, loaded.orgId);
			// A user WorkOS still knows but Postgres does not (deleted through
			// the webhook, or a session that predates the org bootstrap) has
			// to go through the callback again.
			if (!membership) return yield* invalidCredential();
			if (membership.org_trust === 'suspended') return yield* suspendedOrg();
			// Organization-bearing sessions carry the verified provider role.
			// Keep the mirror current so API keys follow the same permissions.
			const role =
				loaded.orgId === null ? membership.role : (loaded.role ?? 'member');
			if (role !== membership.role) {
				yield* sql`UPDATE memberships SET role = ${role}
					WHERE org_id = ${membership.org_id} AND user_id = ${membership.user_id}`.pipe(
					storageError('update organization role')
				);
			}
			return {
				auth: sessionContext(loaded.sessionId, { ...membership, role }),
				refreshedSession
			};
		}),
		completeSignIn: Effect.fn('Auth.completeSignIn')(function* (code) {
			const exchanged = yield* workos.exchangeCode(code);
			const orgId = yield* sql
				.withTransaction(
					Effect.gen(function* () {
						// Serialize first callbacks for one user before checking membership.
						// The separate statement gives a waiter a fresh snapshot after the
						// previous bootstrap commits. Namespace is ASCII "sign".
						yield* sql`SELECT pg_advisory_xact_lock(1936287598, hashtext(${exchanged.user.id}))`;
						const existing = yield* findMembership(
							exchanged.user.id,
							exchanged.organizationId
						);
						const role =
							exchanged.organizationId === null
								? (existing?.role ?? 'owner')
								: (exchanged.role ?? 'member');
						if (existing) {
							if (role !== existing.role) {
								yield* sql`UPDATE memberships SET role = ${role}
						WHERE org_id = ${existing.org_id} AND user_id = ${existing.user_id}`.pipe(
									storageError('update signed-in organization role')
								);
							}
							yield* sql`
					UPDATE users
					SET email = ${exchanged.user.email},
						email_verified = ${exchanged.user.emailVerified}
					WHERE id = ${exchanged.user.id}
				`.pipe(storageError('update signed-in user'));
						}
						const orgId =
							existing?.org_id ??
							exchanged.organizationId ??
							(yield* Effect.gen(function* () {
								// First sign-in: WorkOS does not create a personal org, so
								// mint one there first, then mirror it. The membership is
								// created WorkOS-side so the session can be pinned to it.
								const personal = personalOrgFor(exchanged.user.email);
								const created = yield* workos.createOrganization(personal.name);
								yield* workos.createOrganizationMembership({
									organizationId: created.id,
									userId: exchanged.user.id,
									roleSlug: 'owner'
								});
								return created.id;
							}));
						if (!existing) {
							const personal = personalOrgFor(exchanged.user.email);
							yield* ensureTenant(sql, {
								orgId,
								userId: exchanged.user.id,
								slug: personal.slug,
								name: personal.name,
								email: exchanged.user.email,
								emailVerified: exchanged.user.emailVerified,
								role
							}).pipe(storageError('create tenant rows'));
						}
						// Verified email unlocks sharing; keep promotion with tenant bootstrap.
						if (exchanged.user.emailVerified)
							yield* promoteVerified(sql, orgId);
						return orgId;
					})
				)
				.pipe(
					Effect.catchTag('SqlError', (cause) =>
						Effect.fail(
							new StorageError({ operation: 'complete sign-in', cause })
						)
					)
				);
			// Customer creation happens after the local sign-in commits. Use
			// the stored org and a deterministic known owner, even when a member
			// is the first to sign in after billing is enabled. Without an owner,
			// defer creation until a later sign-in can supply that contact.
			if (autumn.enabled) {
				yield* Effect.gen(function* () {
					const contacts = yield* sql<{ name: string; email: string }>`
							SELECT o.name, u.email
							FROM orgs o
							JOIN memberships m ON m.org_id = o.id AND m.role = 'owner'
							JOIN users u ON u.id = m.user_id
							WHERE o.id = ${orgId} AND u.email <> ''
							ORDER BY u.created_at, u.id
							LIMIT 1`;
					const contact = contacts[0];
					if (!contact) return;
					yield* autumn.ensureCustomer({ customerId: orgId, ...contact });
				}).pipe(
					Effect.catchCause((cause) =>
						Effect.sync(() => {
							// A provider or lookup failure is retried on a later sign-in.
							console.error(
								JSON.stringify({
									message: 'Autumn customer could not be created',
									orgId,
									cause: String(cause)
								})
							);
						})
					)
				);
			}
			// Pin the org on the session so every later request carries it.
			const pinned =
				exchanged.organizationId === orgId
					? exchanged.sealedSession
					: yield* workos.refresh(exchanged.sealedSession, orgId);
			return { sealedSession: pinned ?? exchanged.sealedSession };
		}),
		logoutUrl: Effect.fn('Auth.logoutUrl')(function* (sessionCookie, returnTo) {
			if (!sessionCookie) return returnTo;
			const loaded = yield* workos.loadSession(sessionCookie);
			if (!loaded.authenticated) return returnTo;
			return yield* workos.logoutUrl(loaded.sessionId, returnTo);
		}),
		removeUser: Effect.fn('Auth.removeUser')(function* (userId) {
			yield* sql
				.withTransaction(
					Effect.gen(function* () {
						yield* sql`
							UPDATE device_codes
							SET status = 'denied', api_key_id = NULL, user_id = NULL
							WHERE user_id = ${userId}
								OR api_key_id IN (SELECT id FROM api_keys WHERE user_id = ${userId})`;
						yield* sql`DELETE FROM api_keys WHERE user_id = ${userId}`;
						yield* sql`DELETE FROM memberships WHERE user_id = ${userId}`;
						yield* sql`DELETE FROM users WHERE id = ${userId}`;
					})
				)
				.pipe(storageError('remove user'));
		}),
		removeMembership: Effect.fn('Auth.removeMembership')(
			function* (orgId, userId) {
				yield* sql
					.withTransaction(
						Effect.gen(function* () {
							yield* sql`
							UPDATE api_keys SET revoked_at = ${new Date().toISOString()}
							WHERE org_id = ${orgId} AND user_id = ${userId}
								AND revoked_at IS NULL`;
							yield* sql`
							DELETE FROM memberships
							WHERE org_id = ${orgId} AND user_id = ${userId}`;
						})
					)
					.pipe(storageError('remove membership'));
			}
		),
		listApiKeys,
		createApiKey: Effect.fn('Auth.createApiKey')(function* (name, options) {
			const scope = options?.scope ?? 'read-write';
			const expiresAt = yield* Effect.try({
				try: () => validateExpiration(options?.expiresAt ?? null),
				catch: (cause) =>
					cause instanceof InvalidRequest
						? cause
						: new InvalidRequest({
								status: 400,
								message: 'Key expiration is invalid'
							})
			});
			const generated = yield* makeApiKey(name);
			yield* sql`
				INSERT INTO api_keys (
					id, name, prefix, scope, secret_hash, created_at, expires_at,
					org_id, user_id
				) VALUES (
					${generated.row.id}, ${generated.row.name}, ${generated.row.prefix},
					${scope}, ${generated.secretHash}, ${generated.row.createdAt},
					${expiresAt}, ${org.id}, ${user.id}
				)
			`.pipe(storageError('create API key'));
			return {
				key: {
					...generated.row,
					scope,
					expiresAt,
					lastUsedAt: null,
					revokedAt: null
				},
				token: generated.token
			};
		}),
		revokeApiKey: Effect.fn('Auth.revokeApiKey')(function* (id) {
			const rows = yield* sql`
				UPDATE api_keys
				SET revoked_at = ${new Date().toISOString()}
				WHERE id = ${id} AND org_id = ${org.id} AND revoked_at IS NULL
				RETURNING id
			`.pipe(storageError('revoke API key'));
			if (rows.length !== 1) {
				return yield* new InvalidRequest({
					status: 404,
					message: 'API key was not found'
				});
			}
		}),
		createDeviceAuthorization: Effect.fn('Auth.createDeviceAuthorization')(
			function* (name) {
				const normalizedName = yield* validate(() => normalizeApiKeyName(name));
				const deviceCode = randomToken(32);
				const deviceCodeHash = yield* hashToken(deviceCode);
				const createdAt = new Date();
				const expiresAt = new Date(
					createdAt.getTime() + DEVICE_CODE_TTL_SECONDS * 1000
				);
				let userCode = randomUserCode();
				for (let attempt = 0; attempt < 5; attempt += 1) {
					const rows = yield* sql`
						INSERT INTO device_codes (
							device_code_hash, user_code, status, interval_seconds,
							expires_at, created_at, name
						) VALUES (
							${deviceCodeHash}, ${userCode}, 'pending',
							${DEVICE_POLL_INTERVAL_SECONDS}, ${expiresAt.toISOString()},
							${createdAt.toISOString()}, ${normalizedName}
						)
						ON CONFLICT (user_code) DO NOTHING
						RETURNING device_code_hash
					`.pipe(storageError('create device authorization'));
					if (rows.length === 1) {
						return {
							deviceCode,
							userCode,
							expiresIn: DEVICE_CODE_TTL_SECONDS,
							interval: DEVICE_POLL_INTERVAL_SECONDS
						};
					}
					userCode = randomUserCode();
				}
				return yield* new StorageError({
					operation: 'create device authorization',
					cause: 'Could not allocate a unique approval code'
				});
			}
		),
		approveDevice: Effect.fn('Auth.approveDevice')(function* (userCode) {
			const code = yield* parseUserCode(userCode);
			const now = new Date().toISOString();
			// Approval binds the code to the approving user's org; the key
			// minted when the CLI next polls copies both columns.
			const rows = yield* sql`
				UPDATE device_codes
				SET status = 'approved', approved_at = ${now},
					org_id = ${org.id}, user_id = ${user.id}
				WHERE user_code = ${code} AND status = 'pending' AND expires_at > ${now}
				RETURNING user_code
			`.pipe(storageError('approve device'));
			if (rows.length !== 1) {
				return yield* new InvalidRequest({
					status: 400,
					message: 'Device approval code is invalid or expired'
				});
			}
		}),
		denyDevice: Effect.fn('Auth.denyDevice')(function* (userCode) {
			const code = yield* parseUserCode(userCode);
			const now = new Date().toISOString();
			const rows = yield* sql`
				UPDATE device_codes
				SET status = 'denied'
				WHERE user_code = ${code} AND status = 'pending' AND expires_at > ${now}
				RETURNING user_code
			`.pipe(storageError('deny device'));
			if (rows.length !== 1) {
				return yield* new InvalidRequest({
					status: 400,
					message: 'Device approval code is invalid or expired'
				});
			}
		}),
		pollDevice: Effect.fn('Auth.pollDevice')(function* (deviceCode) {
			if (deviceCode.length < 32 || deviceCode.length > 128) {
				return yield* new Unauthorized({
					message: 'Device authorization is invalid'
				});
			}
			const hash = yield* hashToken(deviceCode);
			const rows = yield* sql`
				SELECT
					device_code_hash, user_code, status, interval_seconds, expires_at,
					last_polled_at, name
				FROM device_codes
				WHERE device_code_hash = ${hash}
				LIMIT 1
			`.pipe(storageError('poll device authorization'));
			const row = decodeRows(DeviceCodeRow, rows)[0];
			if (!row) {
				return yield* new Unauthorized({
					message: 'Device authorization is invalid'
				});
			}
			const now = new Date();
			if (new Date(row.expires_at).getTime() <= now.getTime()) {
				yield* sql`
					UPDATE device_codes SET status = 'expired'
					WHERE device_code_hash = ${hash} AND status IN ('pending', 'approved')
				`.pipe(storageError('expire device authorization'));
				return yield* new Unauthorized({
					message: 'Device authorization expired'
				});
			}
			const lastPoll = row.last_polled_at
				? new Date(row.last_polled_at).getTime()
				: 0;
			if (
				row.status === 'pending' &&
				now.getTime() - lastPoll < row.interval_seconds * 1000
			) {
				return { status: 'slow_down' as const };
			}
			yield* sql`
				UPDATE device_codes SET last_polled_at = ${now.toISOString()}
				WHERE device_code_hash = ${hash}
			`.pipe(storageError('record device poll'));
			if (row.status === 'pending') {
				return { status: 'authorization_pending' as const };
			}
			if (row.status !== 'approved') {
				return yield* new Unauthorized({
					message: 'Device authorization is no longer available'
				});
			}

			const generated = yield* makeApiKey(row.name);
			const consumedAt = now.toISOString();
			// Lock the approval before inserting a key. A concurrent poll must
			// observe the consumed state before it can mint another credential.
			// The key inherits the org and user stamped at approval.
			const completed = yield* sql
				.withTransaction(
					Effect.gen(function* () {
						const approved = yield* sql`
							SELECT device_code_hash FROM device_codes
							WHERE device_code_hash = ${hash} AND status = 'approved'
							FOR UPDATE
						`;
						if (approved.length !== 1) return false;
						const inserted = yield* sql`
							INSERT INTO api_keys (
								id, name, prefix, secret_hash, created_at, org_id, user_id
							)
							SELECT ${generated.row.id}, ${generated.row.name},
								${generated.row.prefix}, ${generated.secretHash},
								${generated.row.createdAt}, org_id, user_id
							FROM device_codes
							WHERE device_code_hash = ${hash} AND status = 'approved'
								AND org_id IS NOT NULL AND user_id IS NOT NULL
							RETURNING id
						`;
						if (inserted.length !== 1) return false;
						const consumed = yield* sql`
							UPDATE device_codes
							SET status = 'consumed', consumed_at = ${consumedAt},
								api_key_id = ${generated.row.id}
							WHERE device_code_hash = ${hash} AND status = 'approved'
							RETURNING device_code_hash
						`;
						return consumed.length === 1;
					})
				)
				.pipe(storageError('complete device authorization'));
			if (!completed) {
				return yield* new Unauthorized({
					message: 'Device authorization was already consumed'
				});
			}
			return { status: 'complete' as const, apiKey: generated.token };
		}),
		sweepExpired: Effect.fn('Auth.sweepExpired')(function* (limit) {
			const bounded = Math.max(1, Math.min(limit, 100));
			const now = new Date().toISOString();
			const cutoff = new Date(
				new Date(now).getTime() - 24 * 60 * 60 * 1_000
			).toISOString();
			const codes = yield* sql`
				DELETE FROM device_codes
				WHERE device_code_hash IN (
					SELECT device_code_hash FROM device_codes
					WHERE expires_at <= ${now}
						OR (status = 'consumed' AND consumed_at <= ${cutoff})
					ORDER BY expires_at
					LIMIT ${bounded}
				)
				RETURNING device_code_hash
			`.pipe(storageError('sweep expired device codes'));
			return codes.length;
		})
	});
});

export const AuthLive = Layer.effect(Auth, makeAuth);
