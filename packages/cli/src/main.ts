import {
	DeviceAuthorizationResponseSchema,
	DevicePendingResponseSchema,
	DeviceTokenResponseSchema,
	FileContentLinkResponseSchema,
	FileListResponseSchema,
	FileMutationResponseSchema,
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
// Deep imports on purpose: the package barrel re-exports NodeRedis,
// whose static `import "ioredis"` would drag the redis client into the
// release bundle (ioredis is a non-optional peer of platform-node).
import * as NodeHttpClient from '@effect/platform-node/NodeHttpClient';
import * as NodeRuntime from '@effect/platform-node/NodeRuntime';
import * as NodeServices from '@effect/platform-node/NodeServices';
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
	HttpBody,
	HttpClient,
	HttpClientRequest,
	HttpClientResponse
} from 'effect/unstable/http';
import mime from 'mime';

// Replaced by esbuild --define at release build time; running from
// source (strip-types) leaves it undefined and falls back to "dev".
declare const __ADRIVE_VERSION__: string | undefined;
const CLI_VERSION =
	typeof __ADRIVE_VERSION__ === 'string' ? __ADRIVE_VERSION__ : 'dev';

const JSON_MODE = process.argv.includes('--json');
if (JSON_MODE) {
	process.argv = process.argv.filter((argument) => argument !== '--json');
}

const CliConfigSchema = Schema.Struct({
	endpoint: Schema.String,
	apiKey: Schema.String,
	contentOrigin: Schema.optional(Schema.String),
	allowHttp: Schema.optional(Schema.Boolean)
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

const LOCAL_HOSTNAMES = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

const isLocalHostname = (hostname: string) =>
	LOCAL_HOSTNAMES.has(hostname) || hostname.endsWith('.localhost');

const assertSecureUrl = (url: URL, allowHttp: boolean, label: string) => {
	if (url.protocol === 'https:') return;
	if (url.protocol === 'http:' && isLocalHostname(url.hostname)) return;
	if (url.protocol === 'http:' && allowHttp) return;
	throw new Error(
		`${label} must use https (or http on localhost). ` +
			'Pass --allow-http at login only for trusted private networks.'
	);
};

const normalizeEndpoint = (value: string, allowHttp: boolean) => {
	const url = new URL(value);
	if (
		!['http:', 'https:'].includes(url.protocol) ||
		url.pathname !== '/' ||
		url.search ||
		url.hash
	) {
		throw new Error('The server URL must be an http(s) origin without a path');
	}
	assertSecureUrl(url, allowHttp, 'The server URL');
	return url.origin;
};

// Server-returned URLs are only trusted on origins the user configured:
// the endpoint itself, or the content origin recorded at login. Anything
// else is rejected before the CLI fetches it or opens a browser to it.
const assertTrustedServerUrl = (
	value: string,
	config: typeof CliConfigSchema.Type,
	label: string
) => {
	const url = new URL(value);
	assertSecureUrl(url, config.allowHttp === true, label);
	const trusted = [config.endpoint, config.contentOrigin].filter(
		(origin): origin is string => typeof origin === 'string'
	);
	if (!trusted.includes(url.origin)) {
		throw new Error(
			`${label} points at an unexpected origin (${url.origin}). ` +
				'Re-run `adrive login` if the server moved.'
		);
	}
	return value;
};

const trustedServerUrl = (
	value: string,
	config: typeof CliConfigSchema.Type,
	label: string
) =>
	Effect.try({
		try: () => assertTrustedServerUrl(value, config, label),
		catch: (cause) =>
			new CliFailure({
				message: cause instanceof Error ? cause.message : `${label} is invalid`,
				cause
			})
	});

// The deployment's content origin is learned from the authenticated list
// endpoint. It must clear the same transport bar as the endpoint itself
// before joining the trust list; an insecure advertisement is discarded.
const discoverContentOrigin = async (
	endpoint: string,
	apiKey: string,
	allowHttp: boolean
) => {
	const response = await fetch(`${endpoint}/api/files`, {
		headers: { authorization: `Bearer ${apiKey}` }
	});
	if (!response.ok) return undefined;
	const body: unknown = await response.json();
	if (
		typeof body === 'object' &&
		body !== null &&
		'contentOrigin' in body &&
		typeof body.contentOrigin === 'string'
	) {
		const origin = new URL(body.contentOrigin);
		assertSecureUrl(
			origin,
			allowHttp,
			'The content origin advertised by the server'
		);
		return origin.origin;
	}
	return undefined;
};

// Configs written before contentOrigin was recorded learn it on demand,
// then persist it.
const withContentOrigin = (config: typeof CliConfigSchema.Type) =>
	config.contentOrigin !== undefined
		? Effect.succeed(config)
		: Effect.tryPromise({
				try: async () => {
					const discovered = await discoverContentOrigin(
						config.endpoint,
						config.apiKey,
						config.allowHttp === true
					);
					return discovered !== undefined
						? { ...config, contentOrigin: discovered }
						: config;
				},
				catch: (cause) =>
					new CliFailure({
						message:
							cause instanceof Error
								? cause.message
								: 'Could not reach the server to confirm its origins',
						cause
					})
			}).pipe(
				Effect.tap((updated) =>
					updated.contentOrigin !== undefined
						? saveConfig(updated).pipe(Effect.ignore)
						: Effect.void
				)
			);

const saveConfig = (config: typeof CliConfigSchema.Type) =>
	Effect.tryPromise({
		try: async () => {
			const path = configPath();
			await mkdir(dirname(path), { recursive: true, mode: 0o700 });
			await writeFile(path, `${JSON.stringify(config, null, 2)}\n`, {
				mode: 0o600
			});
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
	),
	Effect.flatMap((config) =>
		Effect.try({
			try: () => {
				assertSecureUrl(
					new URL(config.endpoint),
					config.allowHttp === true,
					'The configured server URL'
				);
				return config;
			},
			catch: (cause) =>
				new CliFailure({
					message:
						cause instanceof Error
							? `${cause.message} Re-run \`adrive login\`.`
							: 'The configured server URL is invalid',
					cause
				})
		})
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
		allowHttp: Flag.boolean('allow-http').pipe(
			Flag.withDescription(
				'Allow a plain-http server on a trusted private network'
			)
		),
		name: Flag.string('name').pipe(
			Flag.withDefault('adrive CLI'),
			Flag.withDescription('Name for the full-access key created on approval')
		)
	},
	({ endpoint: rawEndpoint, headless, allowHttp, name }) =>
		Effect.gen(function* () {
			const endpoint = yield* Effect.try({
				try: () => normalizeEndpoint(rawEndpoint, allowHttp),
				catch: (cause) =>
					new CliFailure({
						message:
							cause instanceof Error
								? cause.message
								: 'The server URL is invalid',
						cause
					})
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
			// The approval URL is opened in a browser where the dashboard
			// session lives; never follow it to an origin we didn't dial.
			yield* trustedServerUrl(
				authorization.verificationUriComplete,
				{ endpoint, apiKey: '', allowHttp },
				'The verification URL returned by the server'
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
			// Record the deployment's content origin so later commands can
			// verify that server-returned download URLs stay on known ground.
			const contentOrigin = yield* Effect.tryPromise({
				try: () => discoverContentOrigin(endpoint, apiKey, allowHttp),
				catch: () => new CliFailure({ message: 'unreachable' })
			}).pipe(Effect.orElseSucceed(() => undefined));
			yield* saveConfig({
				endpoint,
				apiKey,
				...(contentOrigin ? { contentOrigin } : {}),
				...(allowHttp ? { allowHttp } : {})
			});
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

const list = Command.make('list', {}, () =>
	Effect.gen(function* () {
		const config = yield* loadConfig;
		const client = yield* HttpClient.HttpClient;
		// Follow cursors until the listing is complete; the page guard exists
		// so a misbehaving server cannot loop us forever. JSON mode stays a
		// single document: files accumulate and emit once after the loop.
		const allFiles: Array<
			typeof FileListResponseSchema.Type.files extends ReadonlyArray<infer F>
				? F
				: never
		> = [];
		let lastPage: typeof FileListResponseSchema.Type | null = null;
		let cursor: string | null = null;
		let pages = 0;
		do {
			const params = new URLSearchParams();
			if (cursor) params.set('cursor', cursor);
			const result = yield* client
				.execute(
					apiRequest(
						'GET',
						`${config.endpoint}/api/files${params.size > 0 ? `?${params}` : ''}`,
						config.apiKey
					)
				)
				.pipe(
					Effect.flatMap(ensureOk),
					Effect.flatMap(
						HttpClientResponse.schemaBodyJson(FileListResponseSchema)
					)
				);
			lastPage = result;
			if (wantsJson()) {
				allFiles.push(...result.files);
			} else {
				for (const file of result.files) {
					yield* Console.log(
						`${file.id}\t${file.displayName}\t${file.sizeBytes}\t${file.public ? 'public' : 'private'}`
					);
				}
			}
			cursor = result.nextCursor;
			pages += 1;
		} while (cursor !== null && pages < 500);
		if (cursor !== null) {
			return yield* new CliFailure({
				message:
					'Listing stopped after 500 pages with more remaining; the server may be misbehaving'
			});
		}
		if (wantsJson() && lastPage !== null) {
			yield* emit({ ...lastPage, files: allFiles, nextCursor: null });
		}
	})
).pipe(Command.withDescription('List files'));

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
			const config = yield* loadConfig.pipe(Effect.flatMap(withContentOrigin));
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
			const downloadUrl = yield* trustedServerUrl(
				link.url,
				config,
				'The download URL returned by the server'
			);
			const response = yield* client
				.execute(HttpClientRequest.get(downloadUrl))
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

const rename = Command.make(
	'rename',
	{
		id: Argument.string('id'),
		name: Argument.string('name')
	},
	({ id, name }) =>
		Effect.gen(function* () {
			const config = yield* loadConfig;
			const client = yield* HttpClient.HttpClient;
			const response = yield* client
				.execute(
					apiRequest(
						'PATCH',
						`${config.endpoint}/api/files/${encodeURIComponent(id)}`,
						config.apiKey,
						{
							body: HttpBody.jsonUnsafe({
								action: 'rename',
								displayName: name
							})
						}
					)
				)
				.pipe(Effect.flatMap(ensureOk));
			const result = yield* HttpClientResponse.schemaBodyJson(
				FileMutationResponseSchema
			)(response);
			yield* emit(
				wantsJson()
					? result
					: `Renamed ${result.file.id} to ${result.file.displayName}`
			);
		})
).pipe(Command.withDescription('Rename a file'));

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

const RELEASES_REPO = 'davis7dotsh/aDrive';
const CLI_TAG_PREFIX = 'cli-v';

// Semver comparison including prerelease precedence (1.0.0-beta.1 < 1.0.0;
// prerelease identifiers compare numerically when both numeric, else
// lexically, per semver.org #11).
const compareSemver = (left: string, right: string) => {
	const [leftCore, leftPre = ''] = left.split(/-(.*)/s) as [string, string?];
	const [rightCore, rightPre = ''] = right.split(/-(.*)/s) as [string, string?];
	const parseCore = (value: string) => value.split('.').map(Number);
	const [lMajor = 0, lMinor = 0, lPatch = 0] = parseCore(leftCore);
	const [rMajor = 0, rMinor = 0, rPatch = 0] = parseCore(rightCore);
	const core = lMajor - rMajor || lMinor - rMinor || lPatch - rPatch;
	if (core !== 0) return core;
	if (leftPre === rightPre) return 0;
	if (leftPre === '') return 1; // release > any prerelease
	if (rightPre === '') return -1;
	const leftIds = leftPre.split('.');
	const rightIds = rightPre.split('.');
	for (let i = 0; i < Math.max(leftIds.length, rightIds.length); i += 1) {
		const l = leftIds[i];
		const r = rightIds[i];
		if (l === undefined) return -1; // shorter prerelease sorts first
		if (r === undefined) return 1;
		const lNum = /^\d+$/.test(l) ? Number(l) : null;
		const rNum = /^\d+$/.test(r) ? Number(r) : null;
		if (lNum !== null && rNum !== null) {
			if (lNum !== rNum) return lNum - rNum;
		} else if (lNum !== null) {
			return -1; // numeric < alphanumeric
		} else if (rNum !== null) {
			return 1;
		} else if (l !== r) {
			return l < r ? -1 : 1;
		}
	}
	return 0;
};

const upgrade = Command.make(
	'upgrade',
	{
		check: Flag.boolean('check').pipe(
			Flag.withDescription('Only report whether a newer release exists')
		)
	},
	({ check }) =>
		Effect.gen(function* () {
			if (CLI_VERSION === 'dev') {
				return yield* new CliFailure({
					message:
						'This CLI is running from source; update with `git pull` instead.'
				});
			}
			// /releases/latest returns the newest release of ANY kind; the CLI
			// shares its repo with the app, so list releases and pick the
			// newest cli-v* tag instead.
			const release = yield* Effect.tryPromise({
				try: async () => {
					const response = await fetch(
						`https://api.github.com/repos/${RELEASES_REPO}/releases?per_page=30`,
						{ headers: { accept: 'application/vnd.github+json' } }
					);
					if (!response.ok) {
						throw new Error(`GitHub returned ${response.status}`);
					}
					const body: unknown = await response.json();
					if (!Array.isArray(body)) {
						throw new Error('Release list response was not an array');
					}
					const tags = body
						.map((entry: unknown) =>
							typeof entry === 'object' &&
							entry !== null &&
							'tag_name' in entry &&
							typeof entry.tag_name === 'string'
								? entry.tag_name
								: null
						)
						.filter(
							(tag): tag is string =>
								tag !== null && tag.startsWith(CLI_TAG_PREFIX)
						);
					if (tags.length === 0) {
						throw new Error('No CLI releases found');
					}
					const newest = tags.reduce((best, tag) =>
						compareSemver(
							tag.slice(CLI_TAG_PREFIX.length),
							best.slice(CLI_TAG_PREFIX.length)
						) > 0
							? tag
							: best
					);
					return { tag: newest };
				},
				catch: (cause) =>
					new CliFailure({
						message:
							cause instanceof Error
								? `Could not check for updates: ${cause.message}`
								: 'Could not check for updates',
						cause
					})
			});
			const latest = release.tag.slice(CLI_TAG_PREFIX.length);
			if (compareSemver(latest, CLI_VERSION) <= 0) {
				yield* emit(
					wantsJson()
						? { status: 'current', version: CLI_VERSION, latest }
						: `adrive v${CLI_VERSION} is up to date`
				);
				return;
			}
			if (check) {
				yield* emit(
					wantsJson()
						? { status: 'outdated', version: CLI_VERSION, latest }
						: `adrive v${latest} is available (installed: v${CLI_VERSION}). Run \`adrive upgrade\` to install it.`
				);
				return;
			}
			// JSON mode stays machine-parseable: suppress human narration and
			// the installer's own stdout, then emit a single result line.
			if (!wantsJson()) {
				yield* Console.log(`Upgrading adrive v${CLI_VERSION} -> v${latest}…`);
			}
			// Reuse the blessed installer so upgrade and fresh install can
			// never drift; it verifies checksums and replaces ~/.adrive/bin.
			// Verify the installer against the same release's checksums.txt
			// before executing it — the script runs with the user's shell, so
			// it deserves the same integrity bar it applies to the bundle.
			const script = yield* Effect.tryPromise({
				try: async () => {
					const base = `https://github.com/${RELEASES_REPO}/releases/download/${release.tag}`;
					const [scriptResponse, checksumResponse] = await Promise.all([
						fetch(`${base}/install-cli.sh`),
						fetch(`${base}/checksums.txt`)
					]);
					if (!scriptResponse.ok) {
						throw new Error(
							`installer download returned ${scriptResponse.status}`
						);
					}
					if (!checksumResponse.ok) {
						throw new Error(
							`checksums download returned ${checksumResponse.status}`
						);
					}
					const scriptBytes = new Uint8Array(
						await scriptResponse.arrayBuffer()
					);
					const checksums = await checksumResponse.text();
					const expected = checksums
						.split('\n')
						.map((line) => line.trim().split(/\s+/))
						.find((parts) => parts[1] === 'install-cli.sh')?.[0];
					if (!expected) {
						throw new Error('checksums.txt has no entry for install-cli.sh');
					}
					const digest = await crypto.subtle.digest('SHA-256', scriptBytes);
					const actual = Array.from(new Uint8Array(digest), (byte) =>
						byte.toString(16).padStart(2, '0')
					).join('');
					if (actual !== expected) {
						throw new Error('installer checksum mismatch; aborting');
					}
					return new TextDecoder().decode(scriptBytes);
				},
				catch: (cause) =>
					new CliFailure({
						message:
							cause instanceof Error
								? `Could not download the installer: ${cause.message}`
								: 'Could not download the installer',
						cause
					})
			});
			yield* Effect.tryPromise({
				try: () =>
					new Promise<void>((resolve, reject) => {
						const child = spawn('bash', ['-s', '--'], {
							// In JSON mode the installer's stdout would corrupt the
							// output stream; route it to stderr instead.
							stdio: wantsJson()
								? ['pipe', process.stderr, 'inherit']
								: ['pipe', 'inherit', 'inherit'],
							env: {
								...process.env,
								ADRIVE_CLI_VERSION: release.tag
							}
						});
						child.once('error', reject);
						child.once('close', (status) =>
							status === 0
								? resolve()
								: reject(new Error(`installer exited with ${status}`))
						);
						child.stdin.end(script);
					}),
				catch: (cause) =>
					new CliFailure({
						message:
							cause instanceof Error
								? cause.message
								: 'The installer did not complete',
						cause
					})
			});
			if (wantsJson()) {
				yield* emit({ status: 'upgraded', from: CLI_VERSION, to: latest });
			}
		})
).pipe(Command.withDescription('Update this CLI to the latest release'));

const root = Command.make('adrive', {
	json: Flag.boolean('json').pipe(
		Flag.withDescription('Emit JSON lines on stdout (accepted anywhere)')
	)
}).pipe(
	Command.withDescription('A small CLI for an adrive deployment'),
	Command.withSubcommands([login, list, put, get, rename, site, tag, upgrade])
);

Command.run(root, { version: CLI_VERSION }).pipe(
	Effect.provide([NodeServices.layer, NodeHttpClient.layerNodeHttp]),
	NodeRuntime.runMain
);
