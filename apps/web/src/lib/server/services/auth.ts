import { API_KEY_PATTERN } from '@adrive/shared';
import { Context, Effect, Layer, Schema } from 'effect';
import { SqlClient } from 'effect/unstable/sql';
import { AppConfig } from '../config';
import { MisdirectedRequest, StorageError, Unauthorized } from '../errors';

const ApiKeyRow = Schema.Struct({
	id: Schema.String,
	secret_hash: Schema.String
});

export interface AuthorizeInput {
	readonly authorization: string | null;
	readonly requestOrigin: string;
}

export interface AuthShape {
	readonly authorize: (
		input: AuthorizeInput
	) => Effect.Effect<
		{ readonly keyId: string },
		MisdirectedRequest | Unauthorized | StorageError
	>;
}

export class Auth extends Context.Service<Auth, AuthShape>()('app/Auth') {}

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

const makeAuth = Effect.gen(function* () {
	const sql = yield* SqlClient.SqlClient;
	const config = yield* AppConfig;

	return Auth.of({
		authorize: Effect.fn('Auth.authorize')(function* ({
			authorization,
			requestOrigin
		}) {
			if (requestOrigin !== config.dashboardOrigin) {
				return yield* new MisdirectedRequest({
					message: 'Credentials are accepted only on the dashboard origin'
				});
			}

			const token = authorization?.startsWith('Bearer ')
				? authorization.slice('Bearer '.length)
				: '';
			const match = API_KEY_PATTERN.exec(token);
			if (!match)
				return yield* new Unauthorized({
					message: 'A valid API key is required'
				});

			const rows = yield* sql`
				SELECT id, secret_hash
				FROM api_keys
				WHERE prefix = ${match[1]} AND revoked_at IS NULL
				LIMIT 1
			`.pipe(
				Effect.mapError(
					(cause) => new StorageError({ operation: 'look up API key', cause })
				)
			);
			const decoded = Schema.decodeUnknownOption(Schema.Array(ApiKeyRow))(rows);
			const row = decoded._tag === 'Some' ? decoded.value[0] : undefined;
			const actualHash = yield* hashToken(token);
			const matches = constantTimeEqual(
				hexBytes(actualHash),
				hexBytes(row?.secret_hash ?? '')
			);
			if (!row || !matches) {
				return yield* new Unauthorized({
					message: 'A valid API key is required'
				});
			}

			yield* sql`
				UPDATE api_keys SET last_used_at = ${new Date().toISOString()} WHERE id = ${row.id}
			`.pipe(
				Effect.mapError(
					(cause) =>
						new StorageError({ operation: 'update API key usage', cause })
				)
			);
			return { keyId: row.id };
		})
	});
});

export const AuthLive = Layer.effect(Auth, makeAuth);
