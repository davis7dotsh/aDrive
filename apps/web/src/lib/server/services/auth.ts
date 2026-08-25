import { API_KEY_PATTERN, type ApiKey, type ApiKeyScope } from '@adrive/shared';
import type { Cookies } from '@sveltejs/kit';
import { Context, Effect, Layer, Schema } from 'effect';
import { SqlClient } from 'effect/unstable/sql';
import {
	DEVICE_CODE_TTL_SECONDS,
	DEVICE_POLL_INTERVAL_SECONDS,
	allowsCredentialOrigin,
	bearerToken,
	normalizeApiKeyName,
	normalizeUserCode,
	SESSION_COOKIE,
	SESSION_MAX_AGE_SECONDS,
	shouldTouchLastUsed,
	validateExpiration
} from '../auth-policy';
import { AppConfig } from '../config';
import {
	InvalidRequest,
	MisdirectedRequest,
	StorageError,
	Unauthorized,
	validate
} from '../errors';
import { Db } from './bindings';

const ApiKeyRow = Schema.Struct({
	id: Schema.String,
	name: Schema.String,
	prefix: Schema.String,
	scope: Schema.Literals(['read-only', 'read-write']),
	secret_hash: Schema.String,
	created_at: Schema.String,
	expires_at: Schema.NullOr(Schema.String),
	last_used_at: Schema.NullOr(Schema.String),
	revoked_at: Schema.NullOr(Schema.String),
	allowed_tag_ids: Schema.NullOr(Schema.String),
	allowed_file_ids: Schema.NullOr(Schema.String)
});

// A stored token target is a JSON array of ids, or NULL for "no restriction
// on this axis". Parse defensively: an unreadable value collapses to an empty
// restriction so a corrupt row can never widen access.
const parseIdList = (value: string | null): ReadonlyArray<string> | null => {
	if (value === null) return null;
	try {
		const parsed: unknown = JSON.parse(value);
		if (!Array.isArray(parsed)) return [];
		return parsed.filter((entry): entry is string => typeof entry === 'string');
	} catch {
		return [];
	}
};

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

export interface AuthorizeInput {
	readonly authorization: string | null;
	readonly sessionToken: string | undefined;
	readonly requestOrigin: string;
	readonly origin: string | null;
	readonly method: string;
}

export interface DeviceAuthorization {
	readonly deviceCode: string;
	readonly userCode: string;
	readonly expiresIn: number;
	readonly interval: number;
}

export type DevicePollResult =
	| { readonly status: 'authorization_pending' | 'slow_down' }
	| { readonly status: 'complete'; readonly apiKey: string };

// A scoped token narrows a full-drive key to a set of tags and/or file ids.
// `null` on an axis means "not restricted on that axis"; a credential is
// unrestricted (full drive) only when both are null. Sessions are always
// unrestricted.
export interface TokenRestriction {
	readonly tagIds: ReadonlyArray<string> | null;
	readonly fileIds: ReadonlyArray<string> | null;
}

export interface AuthorizedCredential {
	readonly credentialId: string;
	readonly kind: 'api-key' | 'session';
	readonly scope: ApiKeyScope;
	readonly restriction: TokenRestriction;
}

export interface AuthShape {
	readonly authorize: (
		input: AuthorizeInput
	) => Effect.Effect<
		AuthorizedCredential,
		MisdirectedRequest | Unauthorized | StorageError
	>;
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
			readonly allowedTagIds?: ReadonlyArray<string> | null;
			readonly allowedFileIds?: ReadonlyArray<string> | null;
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

export const authorizeRequest = (
	auth: AuthShape,
	request: Request,
	url: URL,
	cookies: Cookies
) =>
	auth.authorize({
		authorization: request.headers.get('authorization'),
		sessionToken: cookies.get(SESSION_COOKIE),
		requestOrigin: url.origin,
		origin: request.headers.get('origin'),
		method: request.method
	});

// For routes that create, change, or delete data. Read-only API keys are
// authenticated but rejected here with a 403 rather than a 401.
export const authorizeWriteRequest = (
	auth: AuthShape,
	request: Request,
	url: URL,
	cookies: Cookies
) =>
	authorizeRequest(auth, request, url, cookies).pipe(
		Effect.flatMap((credential) =>
			credential.scope === 'read-write'
				? Effect.succeed(credential)
				: Effect.fail(
						new InvalidRequest({
							status: 403,
							message: 'This API key is read-only'
						})
					)
		)
	);

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
	revokedAt: row.revoked_at,
	allowedTagIds: parseIdList(row.allowed_tag_ids),
	allowedFileIds: parseIdList(row.allowed_file_ids)
});

// Normalize a requested target list into a stored value: undefined/null means
// no restriction on that axis (stored as NULL), an empty array is treated the
// same as null, and duplicates are removed. Caps the count so a single key
// cannot carry an unbounded target list.
const MAX_TOKEN_TARGETS = 100;
const normalizeTargets = (
	value: ReadonlyArray<string> | null | undefined
): ReadonlyArray<string> | null => {
	if (value === undefined || value === null) return null;
	const cleaned = [
		...new Set(value.map((entry) => entry.trim()).filter((entry) => entry))
	];
	if (cleaned.length === 0) return null;
	if (cleaned.length > MAX_TOKEN_TARGETS) {
		throw new InvalidRequest({
			status: 400,
			message: `A scoped token may target at most ${MAX_TOKEN_TARGETS} ids`
		});
	}
	return cleaned;
};

const makeAuth = Effect.gen(function* () {
	const db = yield* Db;
	const sql = (yield* SqlClient.SqlClient).withoutTransforms();
	const config = yield* AppConfig;

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
			last_used_at, revoked_at, allowed_tag_ids, allowed_file_ids
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
		authorize: Effect.fn('Auth.authorize')(function* ({
			authorization,
			sessionToken,
			requestOrigin,
			origin,
			method
		}) {
			if (requestOrigin !== config.dashboardOrigin) {
				return yield* new MisdirectedRequest({
					message: 'Credentials are accepted only on the dashboard origin'
				});
			}

			const bearer = bearerToken(authorization);
			if (bearer) {
				const match = API_KEY_PATTERN.exec(bearer);
				if (!match) {
					return yield* new Unauthorized({
						message: 'A valid credential is required'
					});
				}
				const rows = yield* sql`
					SELECT id, name, prefix, scope, secret_hash, created_at, expires_at,
						last_used_at, revoked_at, allowed_tag_ids, allowed_file_ids
					FROM api_keys
					WHERE prefix = ${match[1]} AND revoked_at IS NULL
					LIMIT 1
				`.pipe(
					Effect.mapError(
						(cause) => new StorageError({ operation: 'look up API key', cause })
					)
				);
				const row = decodeRows(ApiKeyRow, rows)[0];
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
					credentialId: row.id,
					kind: 'api-key' as const,
					scope: row.scope,
					restriction: {
						tagIds: parseIdList(row.allowed_tag_ids),
						fileIds: parseIdList(row.allowed_file_ids)
					}
				};
			}

			if (!sessionToken) {
				return yield* new Unauthorized({
					message: 'A valid credential is required'
				});
			}
			if (!allowsCredentialOrigin(method, origin, config.dashboardOrigin)) {
				return yield* new Unauthorized({
					message: 'The request origin is not allowed'
				});
			}
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
				credentialId: row.token_hash,
				kind: 'session' as const,
				scope: 'read-write' as const,
				restriction: { tagIds: null, fileIds: null }
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
			const allowedTagIds = yield* validate(() =>
				normalizeTargets(options?.allowedTagIds)
			);
			const allowedFileIds = yield* validate(() =>
				normalizeTargets(options?.allowedFileIds)
			);
			const tagJson = allowedTagIds ? JSON.stringify(allowedTagIds) : null;
			const fileJson = allowedFileIds ? JSON.stringify(allowedFileIds) : null;
			const generated = yield* makeApiKey(name);
			yield* sql`
				INSERT INTO api_keys (
					id, name, prefix, scope, secret_hash, created_at, expires_at,
					allowed_tag_ids, allowed_file_ids
				) VALUES (
					${generated.row.id}, ${generated.row.name}, ${generated.row.prefix},
					${scope}, ${generated.secretHash}, ${generated.row.createdAt},
					${expiresAt}, ${tagJson}, ${fileJson}
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
					revokedAt: null,
					allowedTagIds,
					allowedFileIds
				},
				token: generated.token
			};
		}),
		revokeApiKey: Effect.fn('Auth.revokeApiKey')(function* (id) {
			const result = yield* Effect.tryPromise({
				try: () =>
					db
						.prepare(
							`UPDATE api_keys
							SET revoked_at = ?
							WHERE id = ? AND revoked_at IS NULL`
						)
						.bind(new Date().toISOString(), id)
						.run(),
				catch: (cause) =>
					new StorageError({ operation: 'revoke API key', cause })
			});
			if (result.meta.changes !== 1) {
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
					const result = yield* Effect.tryPromise({
						try: () =>
							db
								.prepare(
									`INSERT INTO device_codes (
									device_code_hash, user_code, status, interval_seconds,
									expires_at, created_at, name
								) VALUES (?, ?, 'pending', ?, ?, ?, ?)
								ON CONFLICT(user_code) DO NOTHING`
								)
								.bind(
									deviceCodeHash,
									userCode,
									DEVICE_POLL_INTERVAL_SECONDS,
									expiresAt.toISOString(),
									createdAt.toISOString(),
									normalizedName
								)
								.run(),
						catch: (cause) =>
							new StorageError({
								operation: 'create device authorization',
								cause
							})
					});
					if (result.meta.changes === 1) {
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
			const result = yield* Effect.tryPromise({
				try: () =>
					db
						.prepare(
							`UPDATE device_codes
							SET status = 'approved', approved_at = ?
							WHERE user_code = ? AND status = 'pending' AND expires_at > ?`
						)
						.bind(now, code, now)
						.run(),
				catch: (cause) =>
					new StorageError({ operation: 'approve device', cause })
			});
			if (result.meta.changes !== 1) {
				return yield* new InvalidRequest({
					status: 400,
					message: 'Device approval code is invalid or expired'
				});
			}
		}),
		denyDevice: Effect.fn('Auth.denyDevice')(function* (userCode) {
			const code = yield* parseUserCode(userCode);
			const now = new Date().toISOString();
			const result = yield* Effect.tryPromise({
				try: () =>
					db
						.prepare(
							`UPDATE device_codes
							SET status = 'denied'
							WHERE user_code = ? AND status = 'pending' AND expires_at > ?`
						)
						.bind(code, now)
						.run(),
				catch: (cause) => new StorageError({ operation: 'deny device', cause })
			});
			if (result.meta.changes !== 1) {
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
			const results = yield* Effect.tryPromise({
				try: () =>
					db.batch([
						db
							.prepare(
								`INSERT INTO api_keys (
									id, name, prefix, secret_hash, created_at
								)
								SELECT ?, ?, ?, ?, ?
								WHERE EXISTS (
									SELECT 1 FROM device_codes
									WHERE device_code_hash = ? AND status = 'approved'
								)`
							)
							.bind(
								generated.row.id,
								generated.row.name,
								generated.row.prefix,
								generated.secretHash,
								generated.row.createdAt,
								hash
							),
						db
							.prepare(
								`UPDATE device_codes
								SET status = 'consumed', consumed_at = ?, api_key_id = ?
								WHERE device_code_hash = ? AND status = 'approved'`
							)
							.bind(consumedAt, generated.row.id, hash)
					]),
				catch: (cause) =>
					new StorageError({
						operation: 'complete device authorization',
						cause
					})
			});
			if (results[0]?.meta.changes !== 1 || results[1]?.meta.changes !== 1) {
				return yield* new Unauthorized({
					message: 'Device authorization was already consumed'
				});
			}
			return { status: 'complete' as const, apiKey: generated.token };
		}),
		revokeAllSessions: Effect.gen(function* () {
			const results = yield* Effect.tryPromise({
				try: () =>
					db.batch([
						db.prepare('DELETE FROM dashboard_sessions'),
						db.prepare(
							`UPDATE device_codes SET status = 'denied'
							WHERE status IN ('pending', 'approved')`
						)
					]),
				catch: (cause) =>
					new StorageError({ operation: 'revoke all sessions', cause })
			});
			return results.reduce(
				(count, result) => count + (result.meta.changes ?? 0),
				0
			);
		}).pipe(Effect.withSpan('Auth.revokeAllSessions')),
		enforcePasscodeRotation: Effect.gen(function* () {
			const passcodeHash = yield* hashToken(config.passcode);
			const now = new Date().toISOString();
			// One transactional batch (D1 batches are transactions): seed the
			// row on first boot without revoking anything, revoke while the
			// stored hash still differs from the deployed one, then record the
			// new hash. A failure anywhere rolls the whole claim back, so a
			// rotation can never be marked recorded with revocation skipped.
			const results = yield* Effect.tryPromise({
				try: () =>
					db.batch([
						db
							.prepare(
								`INSERT INTO credential_state (id, passcode_hash, rotated_at)
								VALUES (1, ?1, ?2)
								ON CONFLICT(id) DO NOTHING`
							)
							.bind(passcodeHash, now),
						db
							.prepare(
								`DELETE FROM dashboard_sessions
								WHERE EXISTS (
									SELECT 1 FROM credential_state
									WHERE id = 1 AND passcode_hash <> ?1
								)`
							)
							.bind(passcodeHash),
						db
							.prepare(
								`UPDATE device_codes SET status = 'denied'
								WHERE status IN ('pending', 'approved')
									AND EXISTS (
										SELECT 1 FROM credential_state
										WHERE id = 1 AND passcode_hash <> ?1
									)`
							)
							.bind(passcodeHash),
						db
							.prepare(
								`UPDATE credential_state
								SET passcode_hash = ?1, rotated_at = ?2
								WHERE id = 1 AND passcode_hash <> ?1`
							)
							.bind(passcodeHash, now)
					]),
				catch: (cause) =>
					new StorageError({
						operation: 'enforce passcode rotation',
						cause
					})
			});
			const rotated = results[3]?.meta.changes === 1;
			return {
				rotated,
				revoked: rotated
					? (results[1]?.meta.changes ?? 0) + (results[2]?.meta.changes ?? 0)
					: 0
			};
		}).pipe(Effect.withSpan('Auth.enforcePasscodeRotation')),
		sweepExpired: Effect.fn('Auth.sweepExpired')(function* (limit) {
			const bounded = Math.max(1, Math.min(limit, 100));
			const now = new Date().toISOString();
			const cutoff = new Date(
				new Date(now).getTime() - 24 * 60 * 60 * 1_000
			).toISOString();
			const results = yield* Effect.tryPromise({
				try: () =>
					db.batch([
						db
							.prepare(
								`DELETE FROM dashboard_sessions
								WHERE token_hash IN (
									SELECT token_hash FROM dashboard_sessions
									WHERE expires_at <= ?
									ORDER BY expires_at
									LIMIT ?
								)`
							)
							.bind(now, bounded),
						db
							.prepare(
								`DELETE FROM device_codes
								WHERE device_code_hash IN (
									SELECT device_code_hash FROM device_codes
									WHERE expires_at <= ?
										OR (status = 'consumed' AND consumed_at <= ?)
									ORDER BY expires_at
									LIMIT ?
								)`
							)
							.bind(now, cutoff, bounded)
					]),
				catch: (cause) =>
					new StorageError({
						operation: 'sweep expired authentication state',
						cause
					})
			});
			return results.reduce(
				(count, result) => count + (result.meta.changes ?? 0),
				0
			);
		})
	});
});

export const AuthLive = Layer.effect(Auth, makeAuth);
