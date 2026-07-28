import { Context, Effect, Layer, Schema } from 'effect';
import { StorageError } from '../errors';
import {
	mintPrivateGrant,
	verifyPrivateGrant,
	type MintPrivateGrantOptions,
	type PrivateGrant,
	type VerifyPrivateGrantOptions
} from '../private-grant';
import { Db } from './bindings';

const PersistedSecretRow = Schema.Struct({
	content_grant_signing_key: Schema.String
});

const KEY_PATTERN = /^[A-Za-z0-9_-]{43}$/;

type MintGrantInput = Omit<MintPrivateGrantOptions, 'signingKey'>;
type VerifyGrantInput = Omit<VerifyPrivateGrantOptions, 'signingKey'>;

export interface GrantSecretsShape {
	readonly mint: (
		input: MintGrantInput
	) => Effect.Effect<PrivateGrant, StorageError>;
	readonly verify: (
		input: VerifyGrantInput
	) => Effect.Effect<boolean, StorageError>;
}

export class GrantSecrets extends Context.Service<
	GrantSecrets,
	GrantSecretsShape
>()('app/GrantSecrets') {}

const randomSigningKey = () => {
	const bytes = new Uint8Array(32);
	crypto.getRandomValues(bytes);
	return btoa(String.fromCharCode(...bytes))
		.replaceAll('+', '-')
		.replaceAll('/', '_')
		.replace(/=+$/u, '');
};

const makeGrantSecrets = Effect.gen(function* () {
	const db = yield* Db;

	const signingKey = Effect.tryPromise({
		try: async () => {
			const candidate = randomSigningKey();
			await db
				.prepare(
					`INSERT OR IGNORE INTO instance_secrets (
						id, content_grant_signing_key, created_at
					) VALUES (1, ?, ?)`
				)
				.bind(candidate, new Date().toISOString())
				.run();
			const value = await db
				.prepare(
					`SELECT content_grant_signing_key
					FROM instance_secrets
					WHERE id = 1`
				)
				.first();
			const decoded = Schema.decodeUnknownOption(PersistedSecretRow)(value);
			if (
				decoded._tag !== 'Some' ||
				!KEY_PATTERN.test(decoded.value.content_grant_signing_key)
			) {
				throw new Error('The persisted content grant key is unavailable');
			}
			return decoded.value.content_grant_signing_key;
		},
		catch: (cause) =>
			new StorageError({
				operation: 'initialize content grant signing key',
				cause
			})
	});

	return GrantSecrets.of({
		mint: Effect.fn('GrantSecrets.mint')(function* (input) {
			const key = yield* signingKey;
			return yield* Effect.promise(() =>
				mintPrivateGrant({ ...input, signingKey: key })
			);
		}),
		verify: Effect.fn('GrantSecrets.verify')(function* (input) {
			const key = yield* signingKey;
			return yield* Effect.promise(() =>
				verifyPrivateGrant({ ...input, signingKey: key })
			);
		})
	});
});

export const GrantSecretsLive = Layer.effect(GrantSecrets, makeGrantSecrets);
