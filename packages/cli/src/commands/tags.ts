import { TagListResponseSchema, TagResponseSchema } from '@adrive/shared';
import { Console, Effect, Option } from 'effect';
import { Argument, Command, Flag } from 'effect/unstable/cli';
import { HttpBody, HttpClient } from 'effect/unstable/http';
import { tagSet } from './files.ts';
import { loadConfig } from '../config.ts';
import { CliFailure } from '../errors.ts';
import { apiRequest, decodeBody, ensureOk } from '../http.ts';
import { emit, wantsJson } from '../output.ts';

export const tagList = Command.make('list', {}, () =>
	Effect.gen(function* () {
		const config = yield* loadConfig;
		const client = yield* HttpClient.HttpClient;
		const response = yield* client
			.execute(apiRequest('GET', `${config.endpoint}/api/tags`, config.apiKey))
			.pipe(Effect.flatMap(ensureOk));
		const result = yield* decodeBody(TagListResponseSchema, response);
		if (wantsJson()) {
			yield* emit(result);
		} else {
			for (const tag of result.tags) {
				yield* Console.log(`${tag.id}\t${tag.name}\t${tag.fileCount}`);
			}
		}
	})
).pipe(Command.withDescription('List tags'));

export const tagCreate = Command.make(
	'create',
	{
		name: Argument.string('name'),
		color: Flag.string('color').pipe(Flag.optional)
	},
	({ name, color }) =>
		Effect.gen(function* () {
			const config = yield* loadConfig;
			const client = yield* HttpClient.HttpClient;
			const response = yield* client
				.execute(
					apiRequest('POST', `${config.endpoint}/api/tags`, config.apiKey, {
						body: HttpBody.jsonUnsafe({
							name,
							...(Option.isSome(color) ? { color: color.value } : {})
						})
					})
				)
				.pipe(Effect.flatMap(ensureOk));
			const result = yield* decodeBody(TagResponseSchema, response);
			yield* emit(wantsJson() ? result : result.tag.name);
		})
).pipe(Command.withDescription('Create a tag'));

export const tagUpdate = Command.make(
	'update',
	{
		id: Argument.string('id'),
		name: Flag.string('name').pipe(Flag.optional),
		color: Flag.string('color').pipe(Flag.optional)
	},
	({ id, name, color }) =>
		Effect.gen(function* () {
			if (Option.isNone(name) && Option.isNone(color)) {
				return yield* new CliFailure({
					message: 'Provide --name or --color'
				});
			}
			const config = yield* loadConfig;
			const client = yield* HttpClient.HttpClient;
			const response = yield* client
				.execute(
					apiRequest(
						'PATCH',
						`${config.endpoint}/api/tags/${encodeURIComponent(id)}`,
						config.apiKey,
						{
							body: HttpBody.jsonUnsafe({
								...(Option.isSome(name) ? { name: name.value } : {}),
								...(Option.isSome(color) ? { color: color.value } : {})
							})
						}
					)
				)
				.pipe(Effect.flatMap(ensureOk));
			const result = yield* decodeBody(TagResponseSchema, response);
			yield* emit(wantsJson() ? result : result.tag.name);
		})
).pipe(Command.withDescription('Update a tag'));

export const tagDelete = Command.make(
	'delete',
	{ id: Argument.string('id') },
	({ id }) =>
		Effect.gen(function* () {
			const config = yield* loadConfig;
			const client = yield* HttpClient.HttpClient;
			yield* client
				.execute(
					apiRequest(
						'DELETE',
						`${config.endpoint}/api/tags/${encodeURIComponent(id)}`,
						config.apiKey
					)
				)
				.pipe(Effect.flatMap(ensureOk));
			yield* emit(
				wantsJson() ? { id, status: 'deleted' } : `Deleted tag ${id}`
			);
		})
).pipe(Command.withDescription('Delete a tag'));

export const tag = Command.make('tag').pipe(
	Command.withDescription('Manage tags'),
	Command.withSubcommands([tagList, tagCreate, tagUpdate, tagDelete, tagSet])
);
