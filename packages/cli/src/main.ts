#!/usr/bin/env -S node --experimental-strip-types

import {
	normalizeSitePath,
	SiteAssetResponseSchema,
	SiteCommitResponseSchema,
	SiteSessionResponseSchema,
	UploadResponseSchema,
	type SiteManifestAsset
} from '@adrive/shared';
import { NodeRuntime, NodeServices } from '@effect/platform-node';
import {
	chmod,
	lstat,
	mkdir,
	readFile,
	readdir,
	realpath,
	writeFile
} from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, join, relative, sep } from 'node:path';
import {
	Config,
	Console,
	Data,
	Effect,
	FileSystem,
	Option,
	Redacted,
	Schema,
	Stream
} from 'effect';
import { Argument, Command, Flag, Prompt } from 'effect/unstable/cli';
import {
	FetchHttpClient,
	HttpBody,
	HttpClient,
	HttpClientRequest,
	HttpClientResponse
} from 'effect/unstable/http';
import mime from 'mime';

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
	method: 'DELETE' | 'GET' | 'POST' | 'PUT',
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

const login = Command.make(
	'login',
	{
		endpoint: Argument.string('server-url'),
		apiKey: Flag.redacted('api-key').pipe(
			Flag.optional,
			Flag.withDescription('API key (prompted securely when omitted)')
		)
	},
	({ endpoint: rawEndpoint, apiKey: apiKeyOption }) =>
		Effect.gen(function* () {
			const endpoint = yield* Effect.try({
				try: () => normalizeEndpoint(rawEndpoint),
				catch: (cause) =>
					new CliFailure({ message: 'The server URL is invalid', cause })
			});
			const redacted = Option.isSome(apiKeyOption)
				? apiKeyOption.value
				: yield* Prompt.hidden({ message: 'API key' });
			const apiKey = Redacted.value(redacted);
			const client = yield* HttpClient.HttpClient;
			yield* client
				.execute(apiRequest('GET', `${endpoint}/api/auth/check`, apiKey))
				.pipe(Effect.flatMap(ensureOk));
			yield* saveConfig(endpoint, apiKey);
			yield* Console.log(`Logged in to ${endpoint}`);
		})
).pipe(Command.withDescription('Validate and save an API key'));

const put = Command.make(
	'put',
	{
		file: Argument.file('file', { mustExist: true }),
		private: Flag.boolean('private').pipe(
			Flag.withDescription('Upload privately (HTML is always public)')
		)
	},
	({ file, private: isPrivate }) =>
		Effect.gen(function* () {
			const config = yield* loadConfig;
			const client = yield* HttpClient.HttpClient;
			const contentType = mime.getType(file) ?? 'application/octet-stream';
			const body = yield* HttpBody.file(file, { contentType });
			const response = yield* client
				.execute(
					apiRequest('PUT', `${config.endpoint}/api/files`, config.apiKey, {
						body,
						headers: {
							'content-type': contentType,
							'x-adrive-file-name': encodeURIComponent(basename(file)),
							'x-adrive-public': String(!isPrivate)
						}
					})
				)
				.pipe(Effect.flatMap(ensureOk));
			const result =
				yield* HttpClientResponse.schemaBodyJson(UploadResponseSchema)(
					response
				);

			yield* Console.log(`Uploaded ${result.file.displayName}`);
			yield* Console.log(result.url);
			yield* Console.log(
				`${result.file.id} · ${result.file.sizeBytes} bytes · ${result.file.public ? 'public' : 'private'}${result.forcedPublic ? ' (HTML forced public)' : ''}`
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
			const response = yield* client
				.execute(
					apiRequest(
						'GET',
						`${config.endpoint}/api/files/${encodeURIComponent(id)}/content`,
						config.apiKey
					)
				)
				.pipe(Effect.flatMap(ensureOk));
			const destination = Option.getOrElse(
				output,
				() =>
					filenameFromDisposition(response.headers['content-disposition']) ?? id
			);
			yield* Stream.run(response.stream, fs.sink(destination));
			yield* Console.log(`Downloaded ${id} to ${destination}`);
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
			yield* Console.log(`Published ${result.file.displayName}`);
			yield* Console.log(result.url);
			yield* Console.log(
				`${result.file.id} · ${result.assetCount} assets · v${result.file.version} · public${result.cleanupPending ? ' · prior asset cleanup pending' : ''}`
			);
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

const root = Command.make('adrive').pipe(
	Command.withDescription('A small CLI for an adrive deployment'),
	Command.withSubcommands([login, put, get, site])
);

Command.run(root, { version: '0.1.0' }).pipe(
	Effect.provide([NodeServices.layer, FetchHttpClient.layer]),
	NodeRuntime.runMain
);
