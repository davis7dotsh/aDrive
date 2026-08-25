import {
	ApiKeyCreateResponseSchema,
	ApiKeyListResponseSchema
} from '@adrive/shared';
import { Console, Effect, Option } from 'effect';
import { Argument, Command, Flag } from 'effect/unstable/cli';
import { HttpBody, HttpClient } from 'effect/unstable/http';
import { loadConfig } from '../config.ts';
import { CliFailure } from '../errors.ts';
import { apiRequest, decodeBody, ensureOk } from '../http.ts';
import { emit, wantsJson } from '../output.ts';

const splitIds = (value: Option.Option<string>): ReadonlyArray<string> =>
	Option.match(value, {
		onNone: () => [],
		onSome: (raw) =>
			raw
				.split(/[\s,]+/)
				.map((entry) => entry.trim())
				.filter((entry) => entry !== '')
	});

export const keysList = Command.make('list', {}, () =>
	Effect.gen(function* () {
		const config = yield* loadConfig;
		const client = yield* HttpClient.HttpClient;
		const response = yield* client
			.execute(
				apiRequest('GET', `${config.endpoint}/api/auth/keys`, config.apiKey)
			)
			.pipe(Effect.flatMap(ensureOk));
		const result = yield* decodeBody(ApiKeyListResponseSchema, response);
		if (wantsJson()) {
			yield* emit(result);
		} else {
			for (const key of result.keys) {
				const scope =
					key.allowedTagIds || key.allowedFileIds
						? `${key.scope} · scoped`
						: key.scope;
				yield* Console.log(
					`${key.id}\t${key.name}\tadr_${key.prefix}_…\t${scope}${key.revokedAt ? '\trevoked' : ''}`
				);
			}
		}
	})
).pipe(Command.withDescription('List API keys and scoped tokens'));

export const keysCreate = Command.make(
	'create',
	{
		name: Argument.string('name'),
		scope: Flag.string('scope').pipe(
			Flag.optional,
			Flag.withDescription('read-only or read-write (default read-write)')
		),
		expires: Flag.string('expires').pipe(
			Flag.optional,
			Flag.withDescription('Future ISO-8601 expiry timestamp')
		),
		tags: Flag.string('tags').pipe(
			Flag.optional,
			Flag.withDescription('Scope to these tag IDs (comma or space separated)')
		),
		files: Flag.string('files').pipe(
			Flag.optional,
			Flag.withDescription('Scope to these file IDs (comma or space separated)')
		)
	},
	({ name, scope, expires, tags, files }) =>
		Effect.gen(function* () {
			const config = yield* loadConfig;
			const client = yield* HttpClient.HttpClient;
			const scopeValue = Option.getOrUndefined(scope);
			if (
				scopeValue !== undefined &&
				scopeValue !== 'read-only' &&
				scopeValue !== 'read-write'
			) {
				return yield* new CliFailure({
					message: '--scope must be read-only or read-write'
				});
			}
			const allowedTagIds = splitIds(tags);
			const allowedFileIds = splitIds(files);
			const response = yield* client
				.execute(
					apiRequest(
						'POST',
						`${config.endpoint}/api/auth/keys`,
						config.apiKey,
						{
							body: HttpBody.jsonUnsafe({
								name,
								...(scopeValue !== undefined ? { scope: scopeValue } : {}),
								...(Option.isSome(expires) ? { expiresAt: expires.value } : {}),
								...(allowedTagIds.length > 0 ? { allowedTagIds } : {}),
								...(allowedFileIds.length > 0 ? { allowedFileIds } : {})
							})
						}
					)
				)
				.pipe(Effect.flatMap(ensureOk));
			const result = yield* decodeBody(ApiKeyCreateResponseSchema, response);
			if (wantsJson()) {
				yield* emit(result);
			} else {
				yield* Console.log(result.token);
				yield* Console.log(
					`${result.key.id} · ${result.key.name} · ${result.key.scope}${result.key.allowedTagIds || result.key.allowedFileIds ? ' · scoped' : ''}`
				);
			}
		})
).pipe(
	Command.withDescription('Mint an API key (optionally scoped to tags/files)')
);

export const keysRevoke = Command.make(
	'revoke',
	{ id: Argument.string('id') },
	({ id }) =>
		Effect.gen(function* () {
			const config = yield* loadConfig;
			const client = yield* HttpClient.HttpClient;
			yield* client
				.execute(
					apiRequest(
						'DELETE',
						`${config.endpoint}/api/auth/keys/${encodeURIComponent(id)}`,
						config.apiKey
					)
				)
				.pipe(Effect.flatMap(ensureOk));
			yield* emit(
				wantsJson() ? { id, status: 'revoked' } : `Revoked key ${id}`
			);
		})
).pipe(Command.withDescription('Revoke an API key'));

export const keys = Command.make('keys').pipe(
	Command.withDescription('Manage API keys and scoped tokens'),
	Command.withSubcommands([keysList, keysCreate, keysRevoke])
);
