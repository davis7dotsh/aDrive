import {
	FileShareCreateResponseSchema,
	FileShareListResponseSchema
} from '@adrive/shared';
import { Console, Effect, Option } from 'effect';
import { Argument, Command, Flag } from 'effect/unstable/cli';
import { HttpBody, HttpClient } from 'effect/unstable/http';
import { loadConfig } from '../config.ts';
import { CliFailure } from '../errors.ts';
import { apiRequest, decodeBody, ensureOk } from '../http.ts';
import { emit, wantsJson } from '../output.ts';

export const shareCreate = Command.make(
	'create',
	{
		fileId: Argument.string('file-id'),
		password: Flag.string('password').pipe(
			Flag.optional,
			Flag.withDescription('Require this password to view the link')
		),
		expiresDays: Flag.string('expires-days').pipe(
			Flag.optional,
			Flag.withDescription('Lifetime in days (default 7)')
		),
		noExpiry: Flag.boolean('no-expiry').pipe(
			Flag.withDescription('Never expire this link')
		),
		label: Flag.string('label').pipe(Flag.optional)
	},
	({ fileId, password, expiresDays, noExpiry, label }) =>
		Effect.gen(function* () {
			const config = yield* loadConfig;
			const client = yield* HttpClient.HttpClient;
			let expiresInDays: number | null | undefined;
			if (noExpiry) {
				expiresInDays = null;
			} else if (Option.isSome(expiresDays)) {
				const parsed = Number(expiresDays.value);
				if (!Number.isFinite(parsed) || parsed <= 0) {
					return yield* new CliFailure({
						message: '--expires-days must be a positive number'
					});
				}
				expiresInDays = parsed;
			}
			const body: Record<string, unknown> = {};
			if (Option.isSome(password)) body.password = password.value;
			if (expiresInDays !== undefined) body.expiresInDays = expiresInDays;
			if (Option.isSome(label)) body.label = label.value;
			const response = yield* client
				.execute(
					apiRequest(
						'POST',
						`${config.endpoint}/api/files/${encodeURIComponent(fileId)}/shares`,
						config.apiKey,
						{ body: HttpBody.jsonUnsafe(body) }
					)
				)
				.pipe(Effect.flatMap(ensureOk));
			const result = yield* decodeBody(
				FileShareCreateResponseSchema,
				response
			);
			if (wantsJson()) {
				yield* emit(result);
			} else {
				yield* Console.log(result.url);
				yield* Console.log(
					`${result.share.id}${result.share.hasPassword ? ' · password' : ''}${result.share.expiresAt ? ` · expires ${result.share.expiresAt}` : ' · no expiry'}`
				);
			}
		})
).pipe(
	Command.withDescription('Create a durable private link for a file')
);

export const shareList = Command.make(
	'list',
	{ fileId: Argument.string('file-id') },
	({ fileId }) =>
		Effect.gen(function* () {
			const config = yield* loadConfig;
			const client = yield* HttpClient.HttpClient;
			const response = yield* client
				.execute(
					apiRequest(
						'GET',
						`${config.endpoint}/api/files/${encodeURIComponent(fileId)}/shares`,
						config.apiKey
					)
				)
				.pipe(Effect.flatMap(ensureOk));
			const result = yield* decodeBody(FileShareListResponseSchema, response);
			if (wantsJson()) {
				yield* emit(result);
			} else {
				for (const share of result.shares) {
					yield* Console.log(
						`${share.id}\t${share.hasPassword ? 'password' : 'open'}\t${share.expiresAt ?? 'no-expiry'}${share.revokedAt ? '\trevoked' : ''}`
					);
				}
			}
		})
).pipe(Command.withDescription('List durable private links for a file'));

export const shareRevoke = Command.make(
	'revoke',
	{ fileId: Argument.string('file-id'), shareId: Argument.string('share-id') },
	({ fileId, shareId }) =>
		Effect.gen(function* () {
			const config = yield* loadConfig;
			const client = yield* HttpClient.HttpClient;
			yield* client
				.execute(
					apiRequest(
						'DELETE',
						`${config.endpoint}/api/files/${encodeURIComponent(fileId)}/shares/${encodeURIComponent(shareId)}`,
						config.apiKey
					)
				)
				.pipe(Effect.flatMap(ensureOk));
			yield* emit(
				wantsJson()
					? { id: shareId, status: 'revoked' }
					: `Revoked share ${shareId}`
			);
		})
).pipe(Command.withDescription('Revoke a durable private link'));

export const share = Command.make('share').pipe(
	Command.withDescription('Manage durable private links'),
	Command.withSubcommands([shareCreate, shareList, shareRevoke])
);
