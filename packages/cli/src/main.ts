#!/usr/bin/env -S node --experimental-strip-types

import {
	DeviceAuthorizationResponseSchema,
	DevicePendingResponseSchema,
	DeviceTokenResponseSchema,
	FileContentLinkResponseSchema,
	FileTagsResponseSchema,
	normalizeSitePath,
	SiteAssetResponseSchema,
	SiteCommitResponseSchema,
	SiteSessionResponseSchema,
	TagListResponseSchema,
	TagResponseSchema,
	UploadResponseSchema,
	type SiteManifestAsset
} from '@adrive/shared';
import { NodeRuntime, NodeServices } from '@effect/platform-node';
import { createWriteStream } from 'node:fs';
import {
	chmod,
	lstat,
	mkdir,
	mkdtemp,
	readFile,
	readdir,
	realpath,
	rm,
	stat,
	writeFile
} from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { basename, dirname, join, relative, sep } from 'node:path';
import { spawn } from 'node:child_process';
import { pipeline } from 'node:stream/promises';
import {
	Console,
	Data,
	Effect,
	FileSystem,
	Option,
	Schema,
	Stream
} from 'effect';
import { Argument, Command, Flag } from 'effect/unstable/cli';
import {
	FetchHttpClient,
	HttpBody,
	HttpClient,
	HttpClientRequest,
	HttpClientResponse
} from 'effect/unstable/http';
import mime from 'mime';

const JSON_MODE = process.argv.includes('--json');
if (JSON_MODE) {
	process.argv = process.argv.filter((argument) => argument !== '--json');
}

const CliConfigSchema = Schema.Struct({
	endpoint: Schema.String,
	apiKey: Schema.String
});

class CliFailure extends Data.TaggedError('CliFailure')<{
	readonly message: string;
	readonly cause?: unknown;
}> {}

const configPath = () =>
	join(
		process.env.XDG_CONFIG_HOME ?? join(homedir(), '.config'),
		'adrive',
		'config.json'
	);

const normalizeEndpoint = (value: string) => {
	const url = new URL(value);
	if (
		!['http:', 'https:'].includes(url.protocol) ||
		url.pathname !== '/' ||
		url.search ||
		url.hash
	) {
		throw new Error('The server URL must be an http(s) origin without a path');
	}
	return url.origin;
};

const saveConfig = (endpoint: string, apiKey: string) =>
	Effect.tryPromise({
		try: async () => {
			const path = configPath();
			await mkdir(dirname(path), { recursive: true, mode: 0o700 });
			await writeFile(
				path,
				`${JSON.stringify({ endpoint, apiKey }, null, 2)}\n`,
				{
					mode: 0o600
				}
			);
			await chmod(path, 0o600);
		},
		catch: (cause) =>
			new CliFailure({ message: 'Could not save credentials', cause })
	});

const loadConfig = Effect.tryPromise({
	try: () => readFile(configPath(), 'utf8'),
	catch: () =>
		new CliFailure({
			message: 'Not logged in. Run `adrive login <server-url>` first.'
		})
}).pipe(
	Effect.flatMap((text) =>
		Effect.try({
			try: () => JSON.parse(text),
			catch: (cause) =>
				new CliFailure({
					message: 'The adrive config file is not valid JSON',
					cause
				})
		})
	),
	Effect.flatMap(Schema.decodeUnknownEffect(CliConfigSchema)),
	Effect.mapError((cause) =>
		cause instanceof CliFailure
			? cause
			: new CliFailure({ message: 'Could not read credentials', cause })
	)
);

const apiRequest = (
	method: 'DELETE' | 'GET' | 'PATCH' | 'POST' | 'PUT',
	url: string,
	apiKey: string,
	options: {
		readonly body?: HttpBody.HttpBody;
		readonly headers?: Readonly<Record<string, string>>;
	} = {}
) =>
	(method === 'GET'
		? HttpClientRequest.get
		: method === 'POST'
			? HttpClientRequest.post
			: method === 'PATCH'
				? HttpClientRequest.patch
				: method === 'DELETE'
					? HttpClientRequest.delete
					: HttpClientRequest.put)(url, {
		body: options.body,
		headers: {
			authorization: `Bearer ${apiKey}`,
			...options.headers
		}
	});

const ensureOk = (response: HttpClientResponse.HttpClientResponse) =>
	HttpClientResponse.filterStatusOk(response);

const wantsJson = () => JSON_MODE;

const emit = (value: unknown) =>
	Console.log(wantsJson() ? JSON.stringify(value) : String(value));

const responseError = async (response: Response) => {
	try {
		const value: unknown = await response.json();
		if (
			typeof value === 'object' &&
			value !== null &&
			'message' in value &&
			typeof value.message === 'string'
		) {
			return value.message;
		}
	} catch {
		// Fall through to the status.
	}
	return `Request failed (${response.status})`;
};

const openBrowser = (url: string) =>
	Effect.tryPromise({
		try: () =>
			new Promise<void>((resolve, reject) => {
				const command =
					process.platform === 'darwin'
						? 'open'
						: process.platform === 'win32'
							? 'cmd'
							: 'xdg-open';
				const args =
					process.platform === 'win32' ? ['/c', 'start', '', url] : [url];
				const child = spawn(command, args, {
					detached: true,
					stdio: 'ignore'
				});
				child.once('error', reject);
				child.once('spawn', () => {
					child.unref();
					resolve();
				});
			}),
		catch: (cause) =>
			new CliFailure({ message: 'Could not open a browser', cause })
	});

const login = Command.make(
	'login',
	{
		endpoint: Argument.string('server-url'),
		headless: Flag.boolean('headless').pipe(
			Flag.withDescription('Print the approval URL without opening a browser')
		),
		name: Flag.string('name').pipe(
			Flag.withDefault('adrive CLI'),
			Flag.withDescription('Name for the full-access key created on approval')
		)
	},
	({ endpoint: rawEndpoint, headless, name }) =>
		Effect.gen(function* () {
			const endpoint = yield* Effect.try({
				try: () => normalizeEndpoint(rawEndpoint),
				catch: (cause) =>
					new CliFailure({ message: 'The server URL is invalid', cause })
			});
			const authorizationBody = yield* Effect.tryPromise({
				try: async () => {
					const response = await fetch(`${endpoint}/api/auth/device`, {
						method: 'POST',
						headers: { 'Content-Type': 'application/json' },
						body: JSON.stringify({ name })
					});
					if (!response.ok) throw new Error(await responseError(response));
					return response.json();
				},
				catch: (cause) =>
					new CliFailure({
						message:
							cause instanceof Error
								? cause.message
								: 'Could not start device authorization',
						cause
					})
			});
			const authorization = yield* Schema.decodeUnknownEffect(
				DeviceAuthorizationResponseSchema
			)(authorizationBody).pipe(
				Effect.mapError(
					(cause) =>
						new CliFailure({
							message: 'The server returned an invalid device authorization',
							cause
						})
				)
			);
			if (wantsJson()) {
				yield* emit({
					status: 'authorization_required',
					userCode: authorization.userCode,
					verificationUri: authorization.verificationUri,
					verificationUriComplete: authorization.verificationUriComplete
				});
			} else {
				yield* Console.log(
					`Approve this device with code ${authorization.userCode}`
				);
				yield* Console.log(authorization.verificationUriComplete);
				if (!headless) {
					yield* openBrowser(authorization.verificationUriComplete).pipe(
						Effect.catch(() =>
							Console.error(
								'Could not open a browser; open the URL above on any machine.'
							)
						)
					);
				}
			}

			let apiKey = '';
			while (!apiKey) {
				yield* Effect.sleep(`${authorization.interval} seconds`);
				const pollResponse = yield* Effect.tryPromise({
					try: async () => {
						const response = await fetch(`${endpoint}/api/auth/device/token`, {
							method: 'POST',
							headers: { 'Content-Type': 'application/json' },
							body: JSON.stringify({
								deviceCode: authorization.deviceCode
							})
						});
						const body: unknown = await response.json();
						if (response.status === 202 || response.status === 429) {
							return { kind: 'pending' as const, body };
						}
						if (response.ok) return { kind: 'complete' as const, body };
						throw new Error(`Device authorization failed (${response.status})`);
					},
					catch: (cause) =>
						new CliFailure({
							message:
								cause instanceof Error
									? cause.message
									: 'Could not poll device authorization',
							cause
						})
				});
				const poll =
					pollResponse.kind === 'complete'
						? yield* Schema.decodeUnknownEffect(DeviceTokenResponseSchema)(
								pollResponse.body
							).pipe(
								Effect.mapError(
									(cause) =>
										new CliFailure({
											message: 'The server returned an invalid API key',
											cause
										})
								)
							)
						: yield* Schema.decodeUnknownEffect(DevicePendingResponseSchema)(
								pollResponse.body
							).pipe(
								Effect.mapError(
									(cause) =>
										new CliFailure({
											message:
												'The server returned an invalid authorization status',
											cause
										})
								)
							);
				if ('apiKey' in poll) {
					apiKey = poll.apiKey;
				} else if (poll.status === 'slow_down') {
					yield* Effect.sleep(`${authorization.interval} seconds`);
				}
			}
			yield* saveConfig(endpoint, apiKey);
			yield* emit(
				wantsJson()
					? { status: 'authenticated', endpoint }
					: `Logged in to ${endpoint}`
			);
		})
).pipe(Command.withDescription('Authorize this CLI through the dashboard'));

const prepareUpload = (file: string, suppliedName: Option.Option<string>) =>
	Effect.tryPromise({
		try: async () => {
			if (file !== '-') {
				const details = await stat(file);
				if (!details.isFile()) throw new Error('Upload path must be a file');
				return {
					path: file,
					displayName: Option.getOrElse(suppliedName, () => basename(file)),
					temporaryDirectory: null
				};
			}
			const displayName = Option.getOrUndefined(suppliedName)?.trim();
			if (!displayName) {
				throw new Error('`adrive put -` requires --name');
			}
			const temporaryDirectory = await mkdtemp(join(tmpdir(), 'adrive-stdin-'));
			const path = join(temporaryDirectory, 'payload');
			await pipeline(process.stdin, createWriteStream(path, { mode: 0o600 }));
			return { path, displayName, temporaryDirectory };
		},
		catch: (cause) =>
			new CliFailure({ message: 'Could not prepare the upload', cause })
	});

const put = Command.make(
	'put',
	{
		file: Argument.string('file'),
		private: Flag.boolean('private').pipe(
			Flag.withDescription('Upload privately (HTML is always public)')
		),
		name: Flag.string('name').pipe(
			Flag.optional,
			Flag.withDescription('Display name (required when reading stdin as `-`)')
		),
		expires: Flag.string('expires').pipe(
			Flag.optional,
			Flag.withDescription('Future ISO-8601 expiration timestamp')
		)
	},
	({ file, private: isPrivate, name, expires }) =>
		Effect.gen(function* () {
			const config = yield* loadConfig;
			const client = yield* HttpClient.HttpClient;
			const prepared = yield* prepareUpload(file, name);
			const upload = Effect.gen(function* () {
				const contentType =
					mime.getType(prepared.displayName) ?? 'application/octet-stream';
				const body = yield* HttpBody.file(prepared.path, { contentType });
				const response = yield* client
					.execute(
						apiRequest('PUT', `${config.endpoint}/api/files`, config.apiKey, {
							body,
							headers: {
								'content-type': contentType,
								'x-adrive-file-name': encodeURIComponent(prepared.displayName),
								'x-adrive-public': String(!isPrivate),
								...(Option.isSome(expires)
									? { 'x-adrive-expires-at': expires.value }
									: {})
							}
						})
					)
					.pipe(Effect.flatMap(ensureOk));
				const result =
					yield* HttpClientResponse.schemaBodyJson(UploadResponseSchema)(
						response
					);
				if (wantsJson()) {
					yield* emit(result);
				} else {
					yield* Console.log(`Uploaded ${result.file.displayName}`);
					yield* Console.log(result.url);
					yield* Console.log(
						`${result.file.id} · ${result.file.sizeBytes} bytes · ${result.file.public ? 'public' : 'private'}${result.forcedPublic ? ' (HTML forced public)' : ''}${result.file.expiresAt ? ` · expires ${result.file.expiresAt}` : ''}`
					);
				}
			});
			yield* upload.pipe(
				Effect.ensuring(
					prepared.temporaryDirectory
						? Effect.tryPromise({
								try: () =>
									rm(prepared.temporaryDirectory!, {
										recursive: true,
										force: true
									}),
								catch: () => undefined
							}).pipe(Effect.ignore)
						: Effect.void
				)
			);
		})
).pipe(Command.withDescription('Stream a file to adrive'));

const filenameFromDisposition = (value: string | undefined) => {
	if (!value) return undefined;
	const encoded = /filename\*=UTF-8''([^;]+)/i.exec(value)?.[1];
	if (encoded) {
		try {
			return basename(decodeURIComponent(encoded));
		} catch {
			return undefined;
		}
	}
	return /filename="([^"]+)"/i.exec(value)?.[1];
};

const writeStdout = (chunk: Uint8Array) =>
	Effect.callback<void, CliFailure>((resume) => {
		process.stdout.write(chunk, (cause) => {
			if (cause) {
				resume(
					Effect.fail(
						new CliFailure({
							message: 'Could not write downloaded bytes to stdout',
							cause
						})
					)
				);
			} else {
				resume(Effect.void);
			}
		});
	});

const get = Command.make(
	'get',
	{
		id: Argument.string('id'),
		output: Flag.string('output').pipe(
			Flag.optional,
			Flag.withAlias('o'),
			Flag.withDescription(
				'Destination path (defaults to the original file name)'
			)
		)
	},
	({ id, output }) =>
		Effect.gen(function* () {
			const config = yield* loadConfig;
			const client = yield* HttpClient.HttpClient;
			const fs = yield* FileSystem.FileSystem;
			if (Option.getOrUndefined(output) === '-' && wantsJson()) {
				return yield* new CliFailure({
					message: '`--json` cannot be combined with `--output -`'
				});
			}
			const linkResponse = yield* client
				.execute(
					apiRequest(
						'GET',
						`${config.endpoint}/api/files/${encodeURIComponent(id)}/link`,
						config.apiKey
					)
				)
				.pipe(Effect.flatMap(ensureOk));
			const link = yield* HttpClientResponse.schemaBodyJson(
				FileContentLinkResponseSchema
			)(linkResponse);
			const response = yield* client
				.execute(HttpClientRequest.get(link.url))
				.pipe(Effect.flatMap(ensureOk));
			const destination = Option.getOrElse(
				output,
				() =>
					filenameFromDisposition(response.headers['content-disposition']) ?? id
			);
			if (destination === '-') {
				yield* Stream.runForEach(response.stream, writeStdout);
			} else {
				yield* Stream.run(response.stream, fs.sink(destination));
				yield* emit(
					wantsJson()
						? { id, output: destination, status: 'downloaded' }
						: `Downloaded ${id} to ${destination}`
				);
			}
		})
).pipe(Command.withDescription('Stream a file from adrive'));

interface LocalSiteAsset extends SiteManifestAsset {
	readonly file: string;
}

const walkSite = (directory: string) =>
	Effect.tryPromise({
		try: async () => {
			const root = await realpath(directory);
			const rootStat = await lstat(root);
			if (!rootStat.isDirectory()) {
				throw new Error('The site path must be a directory');
			}
			const assets: Array<LocalSiteAsset> = [];

			const walk = async (current: string): Promise<void> => {
				const entries = await readdir(current, { withFileTypes: true });
				entries.sort((left, right) => left.name.localeCompare(right.name));
				for (const entry of entries) {
					const file = join(current, entry.name);
					const stat = await lstat(file);
					if (stat.isSymbolicLink()) {
						throw new Error(
							`Site directories cannot contain symlinks: ${file}`
						);
					}
					if (stat.isDirectory()) {
						await walk(file);
						continue;
					}
					if (!stat.isFile()) {
						throw new Error(
							`Site directories can contain only regular files: ${file}`
						);
					}
					const resolved = await realpath(file);
					const localPath = relative(root, resolved);
					if (
						localPath === '..' ||
						localPath.startsWith(`..${sep}`) ||
						localPath.startsWith(sep)
					) {
						throw new Error(
							`Site asset escaped the selected directory: ${file}`
						);
					}
					const path = normalizeSitePath(localPath.split(sep).join('/'));
					assets.push({
						file: resolved,
						path,
						sizeBytes: stat.size,
						contentType: mime.getType(path) ?? 'application/octet-stream'
					});
				}
			};

			await walk(root);
			return { root, assets };
		},
		catch: (cause) =>
			new CliFailure({
				message: 'Could not safely walk the site directory',
				cause
			})
	});

const uploadSiteAsset = (
	client: HttpClient.HttpClient,
	config: typeof CliConfigSchema.Type,
	sessionId: string,
	asset: LocalSiteAsset
) =>
	Effect.gen(function* () {
		const body = yield* HttpBody.file(asset.file, {
			contentType: asset.contentType
		});
		const params = new URLSearchParams({ path: asset.path });
		const response = yield* client
			.execute(
				apiRequest(
					'PUT',
					`${config.endpoint}/api/sites/sessions/${encodeURIComponent(sessionId)}/assets?${params}`,
					config.apiKey,
					{ body }
				)
			)
			.pipe(Effect.flatMap(ensureOk));
		yield* HttpClientResponse.schemaBodyJson(SiteAssetResponseSchema)(response);
	});

const sitePut = Command.make(
	'put',
	{
		directory: Argument.directory('directory', { mustExist: true }),
		id: Flag.string('id').pipe(
			Flag.optional,
			Flag.withDescription('Existing site UUID to republish')
		),
		name: Flag.string('name').pipe(
			Flag.optional,
			Flag.withDescription('Display name for a new site')
		)
	},
	({ directory, id, name }) =>
		Effect.gen(function* () {
			const config = yield* loadConfig;
			const client = yield* HttpClient.HttpClient;
			const walked = yield* walkSite(directory);
			const displayName = Option.getOrElse(name, () => basename(walked.root));
			const manifest = {
				displayName: displayName || 'site',
				...(Option.isSome(id) ? { fileId: id.value } : {}),
				assets: walked.assets.map(({ path, sizeBytes, contentType }) => ({
					path,
					sizeBytes,
					contentType
				}))
			};
			const createResponse = yield* client
				.execute(
					apiRequest(
						'POST',
						`${config.endpoint}/api/sites/sessions`,
						config.apiKey,
						{ body: HttpBody.jsonUnsafe(manifest) }
					)
				)
				.pipe(Effect.flatMap(ensureOk));
			const session = yield* HttpClientResponse.schemaBodyJson(
				SiteSessionResponseSchema
			)(createResponse);
			const uploadAssets = Effect.forEach(
				walked.assets,
				(asset) => uploadSiteAsset(client, config, session.sessionId, asset),
				{ concurrency: 4, discard: true }
			);
			yield* uploadAssets.pipe(
				Effect.catch((failure) =>
					client
						.execute(
							apiRequest(
								'DELETE',
								`${config.endpoint}/api/sites/sessions/${encodeURIComponent(session.sessionId)}`,
								config.apiKey
							)
						)
						.pipe(
							Effect.flatMap(ensureOk),
							Effect.catchCause(() => Effect.void),
							Effect.andThen(Effect.fail(failure))
						)
				)
			);
			const commitResponse = yield* client
				.execute(
					apiRequest(
						'POST',
						`${config.endpoint}/api/sites/sessions/${encodeURIComponent(session.sessionId)}/commit`,
						config.apiKey
					)
				)
				.pipe(Effect.flatMap(ensureOk));
			const result = yield* HttpClientResponse.schemaBodyJson(
				SiteCommitResponseSchema
			)(commitResponse);
			if (wantsJson()) {
				yield* emit(result);
			} else {
				yield* Console.log(`Published ${result.file.displayName}`);
				yield* Console.log(result.url);
				yield* Console.log(
					`${result.file.id} · ${result.assetCount} assets · v${result.file.version} · public${result.cleanupPending ? ' · prior asset cleanup pending' : ''}`
				);
			}
		})
).pipe(
	Command.withDescription(
		'Walk and publish a static site (use --id to republish)'
	)
);

const site = Command.make('site').pipe(
	Command.withDescription('Publish static sites'),
	Command.withSubcommands([sitePut])
);

const tagList = Command.make('list', {}, () =>
	Effect.gen(function* () {
		const config = yield* loadConfig;
		const client = yield* HttpClient.HttpClient;
		const response = yield* client
			.execute(apiRequest('GET', `${config.endpoint}/api/tags`, config.apiKey))
			.pipe(Effect.flatMap(ensureOk));
		const result = yield* HttpClientResponse.schemaBodyJson(
			TagListResponseSchema
		)(response);
		if (wantsJson()) {
			yield* emit(result);
		} else {
			for (const tag of result.tags) {
				yield* Console.log(`${tag.id}\t${tag.name}\t${tag.fileCount}`);
			}
		}
	})
).pipe(Command.withDescription('List tags'));

const tagCreate = Command.make(
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
			const result =
				yield* HttpClientResponse.schemaBodyJson(TagResponseSchema)(response);
			yield* emit(wantsJson() ? result : result.tag.name);
		})
).pipe(Command.withDescription('Create a tag'));

const tagUpdate = Command.make(
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
			const result =
				yield* HttpClientResponse.schemaBodyJson(TagResponseSchema)(response);
			yield* emit(wantsJson() ? result : result.tag.name);
		})
).pipe(Command.withDescription('Update a tag'));

const tagDelete = Command.make(
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

const tagSet = Command.make(
	'set',
	{
		fileId: Argument.string('file-id'),
		names: Argument.string('names').pipe(Argument.variadic)
	},
	({ fileId, names }) =>
		Effect.gen(function* () {
			const config = yield* loadConfig;
			const client = yield* HttpClient.HttpClient;
			const response = yield* client
				.execute(
					apiRequest(
						'PUT',
						`${config.endpoint}/api/files/${encodeURIComponent(fileId)}/tags`,
						config.apiKey,
						{ body: HttpBody.jsonUnsafe({ names }) }
					)
				)
				.pipe(Effect.flatMap(ensureOk));
			const result = yield* HttpClientResponse.schemaBodyJson(
				FileTagsResponseSchema
			)(response);
			yield* emit(
				wantsJson()
					? result
					: `${result.file.displayName}: ${result.file.tags.map((tag) => tag.name).join(', ')}`
			);
		})
).pipe(Command.withDescription('Replace all tags assigned to a file'));

const tag = Command.make('tag').pipe(
	Command.withDescription('Manage tags'),
	Command.withSubcommands([tagList, tagCreate, tagUpdate, tagDelete, tagSet])
);

const root = Command.make('adrive', {
	json: Flag.boolean('json').pipe(
		Flag.withDescription('Emit JSON lines on stdout (accepted anywhere)')
	)
}).pipe(
	Command.withDescription('A small CLI for an adrive deployment'),
	Command.withSubcommands([login, put, get, site, tag])
);

Command.run(root, { version: '0.1.0' }).pipe(
	Effect.provide([NodeServices.layer, FetchHttpClient.layer]),
	NodeRuntime.runMain
);
