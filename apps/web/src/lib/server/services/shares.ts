import {
	SHARE_TOKEN_PATTERN,
	type FileShare,
	type FileShareCreate
} from '@adrive/shared';
import { Context, Effect, Layer, Schema } from 'effect';
import { AppConfig } from '../config';
import { InvalidRequest, NotFound, StorageError } from '../errors';
import { shouldTouchLastUsed } from '../auth-policy';
import {
	constantTimeEqualHex,
	randomHex,
	randomToken,
	sha256Hex
} from '../token-crypto';
import { Db } from './bindings';

// A share follows the current version and lasts a week unless the caller picks
// another lifetime; a personal operator can pass a different span or turn
// expiry off per share.
export const DEFAULT_SHARE_TTL_DAYS = 7;
const MAX_SHARE_TTL_DAYS = 3650;

const ShareRow = Schema.Struct({
	id: Schema.String,
	file_id: Schema.String,
	label: Schema.NullOr(Schema.String),
	password_hash: Schema.NullOr(Schema.String),
	created_at: Schema.String,
	expires_at: Schema.NullOr(Schema.String),
	last_accessed_at: Schema.NullOr(Schema.String),
	revoked_at: Schema.NullOr(Schema.String)
});

const ResolveRow = Schema.Struct({
	id: Schema.String,
	file_id: Schema.String,
	token_hash: Schema.String,
	password_hash: Schema.NullOr(Schema.String),
	last_accessed_at: Schema.NullOr(Schema.String)
});

const decodeRows = <A, I>(schema: Schema.Codec<A, I, never>, rows: unknown) => {
	const decoded = Schema.decodeUnknownOption(Schema.Array(schema))(rows);
	return decoded._tag === 'Some' ? decoded.value : [];
};

const toShare = (row: typeof ShareRow.Type): FileShare => ({
	id: row.id,
	fileId: row.file_id,
	label: row.label,
	hasPassword: row.password_hash !== null,
	createdAt: row.created_at,
	expiresAt: row.expires_at,
	lastAccessedAt: row.last_accessed_at,
	revokedAt: row.revoked_at
});

export interface ResolvedShare {
	readonly id: string;
	readonly fileId: string;
	readonly passwordHash: string | null;
}

export interface SharesShape {
	readonly create: (
		fileId: string,
		input: FileShareCreate
	) => Effect.Effect<
		{ readonly share: FileShare; readonly token: string; readonly url: string },
		InvalidRequest | NotFound | StorageError
	>;
	readonly list: (
		fileId: string
	) => Effect.Effect<ReadonlyArray<FileShare>, StorageError>;
	readonly revoke: (
		fileId: string,
		id: string
	) => Effect.Effect<void, NotFound | StorageError>;
	// Content-origin lookup: returns the live, unrevoked, unexpired share for a
	// token or null. Never throws NotFound so the caller controls the response.
	readonly resolve: (
		token: string
	) => Effect.Effect<ResolvedShare | null, StorageError>;
	readonly checkPassword: (
		share: ResolvedShare,
		supplied: string
	) => Effect.Effect<boolean, never>;
	readonly shareUrl: (fileId: string, token: string) => string;
}

export class Shares extends Context.Service<Shares, SharesShape>()(
	'app/Shares'
) {}

const passwordHashFor = (shareId: string, password: string) =>
	sha256Hex(`${shareId}\n${password}`);

const resolveExpiresAt = (input: FileShareCreate, now: Date) => {
	if (input.expiresInDays === null) return null;
	const days = input.expiresInDays ?? DEFAULT_SHARE_TTL_DAYS;
	if (!Number.isFinite(days) || days <= 0 || days > MAX_SHARE_TTL_DAYS) {
		throw new InvalidRequest({
			status: 400,
			message: `Share lifetime must be between 1 and ${MAX_SHARE_TTL_DAYS} days`
		});
	}
	return new Date(now.getTime() + days * 24 * 60 * 60 * 1000).toISOString();
};

const makeShares = Effect.gen(function* () {
	const db = yield* Db;
	const config = yield* AppConfig;

	const shareUrl = (fileId: string, token: string) =>
		`${config.contentOrigin}/f/${encodeURIComponent(fileId)}?s=${token}`;

	return Shares.of({
		shareUrl,
		create: Effect.fn('Shares.create')(function* (fileId, input) {
			const target = yield* Effect.tryPromise({
				try: () =>
					db
						.prepare(
							`SELECT is_site FROM files
							WHERE id = ? AND deleted_at IS NULL LIMIT 1`
						)
						.bind(fileId)
						.first<{ is_site: number }>(),
				catch: (cause) =>
					new StorageError({ operation: 'find file to share', cause })
			});
			if (!target) return yield* new NotFound({ id: fileId });
			if (target.is_site === 1) {
				return yield* new InvalidRequest({
					status: 400,
					message: 'Sites are already public at their /s/ URL'
				});
			}
			const now = new Date();
			const expiresAt = yield* Effect.try({
				try: () => resolveExpiresAt(input, now),
				catch: (cause) =>
					cause instanceof InvalidRequest
						? cause
						: new InvalidRequest({
								status: 400,
								message: 'Share lifetime is invalid'
							})
			});
			const id = crypto.randomUUID();
			const prefix = randomHex(4);
			const secret = randomToken();
			const token = `${prefix}_${secret}`;
			const tokenHash = yield* Effect.promise(() => sha256Hex(token));
			const password =
				input.password === undefined || input.password === null
					? null
					: input.password;
			if (password !== null && password.length === 0) {
				return yield* new InvalidRequest({
					status: 400,
					message: 'Share password cannot be empty'
				});
			}
			const passwordHash =
				password === null
					? null
					: yield* Effect.promise(() => passwordHashFor(id, password));
			const label =
				input.label === undefined || input.label === null
					? null
					: input.label.trim().slice(0, 200) || null;
			const createdAt = now.toISOString();
			yield* Effect.tryPromise({
				try: () =>
					db
						.prepare(
							`INSERT INTO file_shares (
								id, file_id, token_prefix, token_hash, password_hash,
								label, created_at, expires_at
							) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
						)
						.bind(
							id,
							fileId,
							prefix,
							tokenHash,
							passwordHash,
							label,
							createdAt,
							expiresAt
						)
						.run(),
				catch: (cause) =>
					new StorageError({ operation: 'create file share', cause })
			});
			return {
				share: {
					id,
					fileId,
					label,
					hasPassword: passwordHash !== null,
					createdAt,
					expiresAt,
					lastAccessedAt: null,
					revokedAt: null
				},
				token,
				url: shareUrl(fileId, token)
			};
		}),
		list: Effect.fn('Shares.list')(function* (fileId) {
			const rows = yield* Effect.tryPromise({
				try: async () => {
					const result = await db
						.prepare(
							`SELECT id, file_id, label, password_hash, created_at,
								expires_at, last_accessed_at, revoked_at
							FROM file_shares
							WHERE file_id = ?
							ORDER BY created_at DESC, id`
						)
						.bind(fileId)
						.all();
					if (!result.success) {
						throw new Error(result.error ?? 'list file shares');
					}
					return result.results;
				},
				catch: (cause) =>
					new StorageError({ operation: 'list file shares', cause })
			});
			return decodeRows(ShareRow, rows).map(toShare);
		}),
		revoke: Effect.fn('Shares.revoke')(function* (fileId, id) {
			const result = yield* Effect.tryPromise({
				try: () =>
					db
						.prepare(
							`UPDATE file_shares SET revoked_at = ?
							WHERE id = ? AND file_id = ? AND revoked_at IS NULL`
						)
						.bind(new Date().toISOString(), id, fileId)
						.run(),
				catch: (cause) =>
					new StorageError({ operation: 'revoke file share', cause })
			});
			if (result.meta.changes !== 1) {
				return yield* new NotFound({ id });
			}
		}),
		resolve: Effect.fn('Shares.resolve')(function* (token) {
			const match = SHARE_TOKEN_PATTERN.exec(token);
			if (!match) return null;
			const now = new Date();
			const nowIso = now.toISOString();
			const rows = yield* Effect.tryPromise({
				try: async () => {
					const result = await db
						.prepare(
							`SELECT id, file_id, token_hash, password_hash, last_accessed_at
							FROM file_shares
							WHERE token_prefix = ? AND revoked_at IS NULL
								AND (expires_at IS NULL OR expires_at > ?)
							LIMIT 1`
						)
						.bind(match[1], nowIso)
						.all();
					if (!result.success) {
						throw new Error(result.error ?? 'resolve share');
					}
					return result.results;
				},
				catch: (cause) =>
					new StorageError({ operation: 'resolve share', cause })
			});
			const row = decodeRows(ResolveRow, rows)[0];
			if (!row) return null;
			const actualHash = yield* Effect.promise(() => sha256Hex(token));
			if (!constantTimeEqualHex(actualHash, row.token_hash)) return null;
			if (shouldTouchLastUsed(row.last_accessed_at, now)) {
				yield* Effect.tryPromise({
					try: () =>
						db
							.prepare(
								`UPDATE file_shares SET last_accessed_at = ? WHERE id = ?`
							)
							.bind(nowIso, row.id)
							.run(),
					catch: (cause) =>
						new StorageError({ operation: 'touch share access', cause })
				});
			}
			return {
				id: row.id,
				fileId: row.file_id,
				passwordHash: row.password_hash
			};
		}),
		checkPassword: (share, supplied) =>
			Effect.gen(function* () {
				if (share.passwordHash === null) return true;
				if (supplied.length === 0) return false;
				const hash = yield* Effect.promise(() =>
					passwordHashFor(share.id, supplied)
				);
				return constantTimeEqualHex(hash, share.passwordHash);
			})
	});
});

export const SharesLive = Layer.effect(Shares, makeShares);
