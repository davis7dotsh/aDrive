import { API_KEY_PATTERN, type ApiKey, type ApiKeyScope } from '@adrive/shared';
import { Context, Effect, Layer, Schema } from 'effect';
import {
	DEVICE_CODE_TTL_SECONDS,
	DEVICE_POLL_INTERVAL_SECONDS,
	normalizeApiKeyName,
	normalizeUserCode,
	SESSION_MAX_AGE_SECONDS,
	shouldTouchLastUsed,
	validateExpiration
} from '../auth-policy';
import { AppConfig } from '../config';
import {
	InvalidRequest,
	StorageError,
	Unauthorized,
	validate
} from '../errors';
import type { AuthContext } from '../identity';
import { PgSql } from '../pg';
import { BOOTSTRAP_TENANT, ensureTenant } from '../tenants';
import { CurrentOrg, CurrentUser } from './current-org';

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

const ApiKeyCredentialRow = Schema.Struct({
	id: Schema.String,
	scope: Schema.Literals(['read-only', 'read-write']),
	secret_hash: Schema.String,
	expires_at: Schema.NullOr(Schema.String),
	last_used_at: Schema.NullOr(Schema.String),
	org_id: Schema.String,
	user_id: Schema.String,
	role: Schema.NullOr(Schema.String)
});

const SessionRow = Schema.Struct({
	token_hash: Schema.String,
	expires_at: Schema.String,
	last_used_at: Schema.String
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
	// Both resolvers turn a presented credential into the identity the
	// request acts as, or Unauthorized when it is unknown, expired, or
	// revoked. The handle hook calls them once per request.
	readonly resolveApiKey: (
		bearer: string
	) => Effect.Effect<AuthContext, Unauthorized | StorageError>;
	readonly resolveSession: (
		sessionToken: string
	) => Effect.Effect<AuthContext, Unauthorized | StorageError>;
	readonly createSession: (
		passcode: string
	) => Effect.Effect<string, Unauthorized | StorageError>;
	readonly revokeSession: (
		sessionToken: string | undefined
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
	// Revokes every browser session and outstanding device code. API keys
	// survive; revoke those individually from the dashboard.
	readonly revokeAllSessions: Effect.Effect<number, StorageError>;
	// Compares the deployed PASSCODE with the recorded hash; on change,
	// revokes all sessions and device codes and records the rotation time.
	readonly enforcePasscodeRotation: Effect.Effect<
		{ readonly rotated: boolean; readonly revoked: number },
		StorageError
	>;
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

const makeAuth = Effect.gen(function* () {
	const sql = yield* PgSql;
	const config = yield* AppConfig;
	const org = yield* CurrentOrg;
	const user = yield* CurrentUser;

	const storageError = (operation: string) =>
		Effect.mapError((cause: unknown) => new StorageError({ operation, cause }));

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

	const listApiKeys = sql`
		SELECT id, name, prefix, scope, secret_hash, created_at, expires_at,
			last_used_at, revoked_at
		FROM api_keys
		ORDER BY created_at DESC, id
	`.pipe(
		Effect.map((rows) => decodeRows(ApiKeyRow, rows).map(toApiKey)),
		Effect.mapError(
			(cause) => new StorageError({ operation: 'list API keys', cause })
		),
		Effect.withSpan('Auth.listApiKeys')
	);

	return Auth.of({
		// The prefix lookup is global (prefixes are unique across orgs); the
		// org and user the key acts as come from the key row itself.
		resolveApiKey: Effect.fn('Auth.resolveApiKey')(function* (bearer) {
			const match = API_KEY_PATTERN.exec(bearer);
			if (!match) {
				return yield* new Unauthorized({
					message: 'A valid credential is required'
				});
			}
			const rows = yield* sql`
				SELECT k.id, k.scope, k.secret_hash, k.expires_at, k.last_used_at,
					k.org_id, k.user_id, m.role
				FROM api_keys k
				LEFT JOIN memberships m ON m.org_id = k.org_id AND m.user_id = k.user_id
				WHERE k.prefix = ${match[1]} AND k.revoked_at IS NULL
				LIMIT 1
			`.pipe(
				Effect.mapError(
					(cause) => new StorageError({ operation: 'look up API key', cause })
				)
			);
			const row = decodeRows(ApiKeyCredentialRow, rows)[0];
			const actualHash = yield* hashToken(bearer);
			if (
				!row ||
				!constantTimeEqual(hexBytes(actualHash), hexBytes(row.secret_hash))
			) {
				return yield* new Unauthorized({
					message: 'A valid credential is required'
				});
			}
			const now = new Date();
			const nowIso = now.toISOString();
			if (row.expires_at !== null && row.expires_at <= nowIso) {
				return yield* new Unauthorized({
					message: 'This API key has expired'
				});
			}
			// A key whose owner left the org stops working with it.
			if (row.role === null) {
				return yield* new Unauthorized({
					message: 'This API key no longer belongs to an organization member'
				});
			}
			if (shouldTouchLastUsed(row.last_used_at, now)) {
				yield* sql`
					UPDATE api_keys
					SET last_used_at = ${nowIso}
					WHERE id = ${row.id}
				`.pipe(
					Effect.mapError(
						(cause) =>
							new StorageError({ operation: 'update API key usage', cause })
					)
				);
			}
			return {
				orgId: row.org_id,
				userId: row.user_id,
				role: row.role,
				via: 'api-key' as const,
				scope: row.scope,
				credentialId: row.id
			};
		}),
		resolveSession: Effect.fn('Auth.resolveSession')(function* (sessionToken) {
			const tokenHash = yield* hashToken(sessionToken);
			const now = new Date();
			const nowIso = now.toISOString();
			const rows = yield* sql`
				SELECT token_hash, expires_at, last_used_at
				FROM dashboard_sessions
				WHERE token_hash = ${tokenHash} AND expires_at > ${nowIso}
				LIMIT 1
			`.pipe(
				Effect.mapError(
					(cause) =>
						new StorageError({ operation: 'look up dashboard session', cause })
				)
			);
			const row = decodeRows(SessionRow, rows)[0];
			if (!row) {
				return yield* new Unauthorized({
					message: 'A valid credential is required'
				});
			}
			if (shouldTouchLastUsed(row.last_used_at, now)) {
				yield* sql`
					UPDATE dashboard_sessions SET last_used_at = ${nowIso}
					WHERE token_hash = ${tokenHash}
				`.pipe(
					Effect.mapError(
						(cause) =>
							new StorageError({
								operation: 'update dashboard session',
								cause
							})
					)
				);
			}
			return {
				orgId: BOOTSTRAP_TENANT.orgId,
				userId: BOOTSTRAP_TENANT.userId,
				role: 'owner',
				via: 'session' as const,
				scope: 'read-write' as const,
				credentialId: row.token_hash
			};
		}),
		createSession: Effect.fn('Auth.createSession')(function* (passcode) {
			const expected = yield* hashToken(config.passcode);
			const actual = yield* hashToken(passcode);
			if (!constantTimeEqual(hexBytes(expected), hexBytes(actual))) {
				return yield* new Unauthorized({ message: 'Passcode is incorrect' });
			}
			const token = randomToken();
			const tokenHash = yield* hashToken(token);
			const createdAt = new Date();
			const expiresAt = new Date(
				createdAt.getTime() + SESSION_MAX_AGE_SECONDS * 1000
			);
			yield* ensureTenant(sql, BOOTSTRAP_TENANT).pipe(
				Effect.mapError(
					(cause) =>
						new StorageError({ operation: 'ensure bootstrap tenant', cause })
				)
			);
			yield* sql`
				INSERT INTO dashboard_sessions (
					token_hash, created_at, expires_at, last_used_at
				) VALUES (
					${tokenHash}, ${createdAt.toISOString()}, ${expiresAt.toISOString()},
					${createdAt.toISOString()}
				)
			`.pipe(
				Effect.mapError(
					(cause) =>
						new StorageError({ operation: 'create dashboard session', cause })
				)
			);
			return token;
		}),
		revokeSession: Effect.fn('Auth.revokeSession')(function* (sessionToken) {
			if (!sessionToken) return;
			const hash = yield* hashToken(sessionToken);
			yield* sql`DELETE FROM dashboard_sessions WHERE token_hash = ${hash}`.pipe(
				Effect.mapError(
					(cause) =>
						new StorageError({ operation: 'revoke dashboard session', cause })
				)
			);
		}),
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
			`.pipe(
				Effect.mapError(
					(cause) => new StorageError({ operation: 'create API key', cause })
				)
			);
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
				WHERE id = ${id} AND revoked_at IS NULL
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
			`.pipe(
				Effect.mapError(
					(cause) =>
						new StorageError({ operation: 'poll device authorization', cause })
				)
			);
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
				`.pipe(
					Effect.mapError(
						(cause) =>
							new StorageError({
								operation: 'expire device authorization',
								cause
							})
					)
				);
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
			`.pipe(
				Effect.mapError(
					(cause) =>
						new StorageError({ operation: 'record device poll', cause })
				)
			);
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
		revokeAllSessions: sql
			.withTransaction(
				Effect.gen(function* () {
					const sessions = yield* sql`
						DELETE FROM dashboard_sessions RETURNING token_hash
					`;
					const codes = yield* sql`
						UPDATE device_codes SET status = 'denied'
						WHERE status IN ('pending', 'approved')
						RETURNING device_code_hash
					`;
					return sessions.length + codes.length;
				})
			)
			.pipe(
				storageError('revoke all sessions'),
				Effect.withSpan('Auth.revokeAllSessions')
			),
		enforcePasscodeRotation: Effect.gen(function* () {
			const passcodeHash = yield* hashToken(config.passcode);
			const now = new Date().toISOString();
			// One transaction: seed the row on first boot without revoking
			// anything, revoke while the stored hash still differs from the
			// deployed one, then record the new hash. A failure anywhere rolls
			// the whole claim back, so a rotation can never be marked recorded
			// with revocation skipped.
			return yield* sql
				.withTransaction(
					Effect.gen(function* () {
						yield* sql`
							INSERT INTO credential_state (id, passcode_hash, rotated_at)
							VALUES (1, ${passcodeHash}, ${now})
							ON CONFLICT (id) DO NOTHING
						`;
						const sessions = yield* sql`
							DELETE FROM dashboard_sessions
							WHERE EXISTS (
								SELECT 1 FROM credential_state
								WHERE id = 1 AND passcode_hash <> ${passcodeHash}
							)
							RETURNING token_hash
						`;
						const codes = yield* sql`
							UPDATE device_codes SET status = 'denied'
							WHERE status IN ('pending', 'approved')
								AND EXISTS (
									SELECT 1 FROM credential_state
									WHERE id = 1 AND passcode_hash <> ${passcodeHash}
								)
							RETURNING device_code_hash
						`;
						const recorded = yield* sql`
							UPDATE credential_state
							SET passcode_hash = ${passcodeHash}, rotated_at = ${now}
							WHERE id = 1 AND passcode_hash <> ${passcodeHash}
							RETURNING id
						`;
						const rotated = recorded.length === 1;
						return {
							rotated,
							revoked: rotated ? sessions.length + codes.length : 0
						};
					})
				)
				.pipe(storageError('enforce passcode rotation'));
		}).pipe(Effect.withSpan('Auth.enforcePasscodeRotation')),
		sweepExpired: Effect.fn('Auth.sweepExpired')(function* (limit) {
			const bounded = Math.max(1, Math.min(limit, 100));
			const now = new Date().toISOString();
			const cutoff = new Date(
				new Date(now).getTime() - 24 * 60 * 60 * 1_000
			).toISOString();
			return yield* sql
				.withTransaction(
					Effect.gen(function* () {
						const sessions = yield* sql`
							DELETE FROM dashboard_sessions
							WHERE token_hash IN (
								SELECT token_hash FROM dashboard_sessions
								WHERE expires_at <= ${now}
								ORDER BY expires_at
								LIMIT ${bounded}
							)
							RETURNING token_hash
						`;
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
						`;
						return sessions.length + codes.length;
					})
				)
				.pipe(storageError('sweep expired authentication state'));
		})
	});
});

export const AuthLive = Layer.effect(Auth, makeAuth);
