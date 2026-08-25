import {
	FileContentLinkResponseSchema,
	FileListResponseSchema,
	FileMutationResponseSchema,
	FileTagsResponseSchema,
	UploadPartResponseSchema,
	UploadResponseSchema,
	UploadSessionResponseSchema
} from '@adrive/shared';
import { createWriteStream } from 'node:fs';
import { mkdtemp, open, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Console, Effect, FileSystem, Option, Stream } from 'effect';
import { Argument, Command, Flag } from 'effect/unstable/cli';
import { HttpBody, HttpClient, HttpClientRequest } from 'effect/unstable/http';
import mime from 'mime';
import { loadConfig, withContentOrigin } from '../config.ts';
import { CliFailure } from '../errors.ts';
import { apiRequest, decodeBody, ensureOk } from '../http.ts';
import { emit, formatBytes, wantsJson } from '../output.ts';
import { trustedServerUrl } from '../url-trust.ts';

export const status = Command.make('status', {}, () =>
	Effect.gen(function* () {
		const config = yield* loadConfig;
		const client = yield* HttpClient.HttpClient;
		// Page through the listing so counts cover the whole drive, keeping
		// the first page for its deployment metadata (tags, semantic, limits).
		const gather = Effect.gen(function* () {
			let firstPage: typeof FileListResponseSchema.Type | null = null;
			let files = 0;
			let sites = 0;
			let publicCount = 0;
			let totalBytes = 0;
			let cursor: string | null = null;
			let pages = 0;
			do {
				const params = new URLSearchParams();
				if (cursor) params.set('cursor', cursor);
				const page = yield* client
					.execute(
						apiRequest(
							'GET',
							`${config.endpoint}/api/files${params.size > 0 ? `?${params}` : ''}`,
							config.apiKey
						)
					)
					.pipe(
						Effect.flatMap(ensureOk),
						Effect.flatMap((response) =>
							decodeBody(FileListResponseSchema, response)
						)
					);
				firstPage ??= page;
				for (const item of page.files) {
					if (item.kind === 'site') {
						sites += 1;
					} else {
						files += 1;
						if (item.public) publicCount += 1;
					}
					totalBytes += item.sizeBytes;
				}
				cursor = page.nextCursor;
				pages += 1;
			} while (cursor !== null && pages < 500);
			if (cursor !== null) {
				return yield* new CliFailure({
					message:
						'Listing stopped after 500 pages with more remaining; the server may be misbehaving'
				});
			}
			if (firstPage === null) {
				return yield* new CliFailure({
					message: 'The server returned no listing pages'
				});
			}
			return { firstPage, files, sites, publicCount, totalBytes };
		});
		const result = yield* gather.pipe(
			Effect.catch((failure) =>
				Effect.gen(function* () {
					if (!wantsJson()) {
						yield* Console.log(`Server      ${config.endpoint}`);
						yield* Console.log('Connected   no');
					}
					return yield* failure;
				})
			)
		);
		const { firstPage, files, sites, publicCount, totalBytes } = result;
		const privateCount = files - publicCount;
		if (wantsJson()) {
			yield* emit({
				endpoint: config.endpoint,
				contentOrigin: firstPage.contentOrigin,
				connected: true,
				files,
				sites,
				publicFiles: publicCount,
				privateFiles: privateCount,
				totalBytes,
				tags: firstPage.tags.length,
				maxUploadBytes: firstPage.maxUploadBytes,
				maxStagedUploadBytes: firstPage.maxStagedUploadBytes,
				semantic: firstPage.semantic
			});
		} else {
			const semantic = firstPage.semantic.enabled
				? `enabled · ${firstPage.semantic.indexedChunks} chunks indexed`
				: 'disabled';
			yield* Console.log(`Server      ${config.endpoint}`);
			yield* Console.log('Connected   yes');
			yield* Console.log(
				`Files       ${files} (${publicCount} public · ${privateCount} private)`
			);
			yield* Console.log(`Sites       ${sites}`);
			yield* Console.log(`Storage     ${formatBytes(totalBytes)}`);
			yield* Console.log(`Tags        ${firstPage.tags.length}`);
			yield* Console.log(
				`Max upload  ${formatBytes(firstPage.maxUploadBytes)} (staged ${formatBytes(firstPage.maxStagedUploadBytes)})`
			);
			yield* Console.log(`Semantic    ${semantic}`);
		}
	})
).pipe(Command.withDescription('Show connection and drive usage at a glance'));

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

type UploadResult = typeof UploadResponseSchema.Type;

const printUpload = (result: UploadResult) =>
	Effect.gen(function* () {
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

const uploadCaps = (
	client: HttpClient.HttpClient,
	endpoint: string,
	apiKey: string
) =>
	client.execute(apiRequest('GET', `${endpoint}/api/files`, apiKey)).pipe(
		Effect.flatMap(ensureOk),
		Effect.flatMap((response) => decodeBody(FileListResponseSchema, response))
	);

const oneShotUpload = (
	client: HttpClient.HttpClient,
	config: { endpoint: string; apiKey: string },
	prepared: { path: string; displayName: string },
	contentType: string,
	isPrivate: boolean,
	expires: Option.Option<string>
) =>
	Effect.gen(function* () {
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
		return yield* decodeBody(UploadResponseSchema, response);
	});

// Files larger than the one-shot cap go through the staged multipart flow:
// open a session, PUT each part read straight off disk, then finalize. A
// failure aborts the session so no partial upload lingers.
const stagedUpload = (
	client: HttpClient.HttpClient,
	config: { endpoint: string; apiKey: string },
	prepared: { path: string; displayName: string },
	contentType: string,
	size: number,
	isPrivate: boolean,
	expires: Option.Option<string>
) =>
	Effect.gen(function* () {
		const createResponse = yield* client
			.execute(
				apiRequest('POST', `${config.endpoint}/api/uploads`, config.apiKey, {
					body: HttpBody.jsonUnsafe({
						name: prepared.displayName,
						sizeBytes: size,
						contentType,
						public: !isPrivate,
						...(Option.isSome(expires) ? { expiresAt: expires.value } : {})
					})
				})
			)
			.pipe(Effect.flatMap(ensureOk));
		const session = yield* decodeBody(
			UploadSessionResponseSchema,
			createResponse
		);
		const sendParts = Effect.gen(function* () {
			const handle = yield* Effect.tryPromise({
				try: () => open(prepared.path, 'r'),
				catch: (cause) =>
					new CliFailure({ message: 'Could not read the file', cause })
			});
			yield* Effect.gen(function* () {
				for (
					let partNumber = 1;
					partNumber <= session.partCount;
					partNumber += 1
				) {
					const start = (partNumber - 1) * session.partSize;
					const length = Math.min(session.partSize, size - start);
					const bytes = yield* Effect.tryPromise({
						try: async () => {
							const buffer = Buffer.alloc(length);
							await handle.read(buffer, 0, length, start);
							return buffer;
						},
						catch: (cause) =>
							new CliFailure({ message: 'Could not read a file part', cause })
					});
					yield* client
						.execute(
							apiRequest(
								'PUT',
								`${config.endpoint}/api/uploads/${encodeURIComponent(session.sessionId)}/parts/${partNumber}`,
								config.apiKey,
								{ body: HttpBody.uint8Array(bytes, contentType) }
							)
						)
						.pipe(
							Effect.flatMap(ensureOk),
							Effect.flatMap((response) =>
								decodeBody(UploadPartResponseSchema, response)
							)
						);
				}
			}).pipe(
				Effect.ensuring(
					Effect.tryPromise({
						try: () => handle.close(),
						catch: () => undefined
					}).pipe(Effect.ignore)
				)
			);
		});
		yield* sendParts.pipe(
			Effect.catch((failure) =>
				client
					.execute(
						apiRequest(
							'DELETE',
							`${config.endpoint}/api/uploads/${encodeURIComponent(session.sessionId)}`,
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
		const completeResponse = yield* client
			.execute(
				apiRequest(
					'POST',
					`${config.endpoint}/api/uploads/${encodeURIComponent(session.sessionId)}/complete`,
					config.apiKey
				)
			)
			.pipe(Effect.flatMap(ensureOk));
		return yield* decodeBody(UploadResponseSchema, completeResponse);
	});

export const put = Command.make(
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
				const size = yield* Effect.tryPromise({
					try: () => stat(prepared.path).then((details) => details.size),
					catch: (cause) =>
						new CliFailure({ message: 'Could not size the file', cause })
				});
				const caps = yield* uploadCaps(client, config.endpoint, config.apiKey);
				if (size > caps.maxStagedUploadBytes) {
					return yield* new CliFailure({
						message: 'That is too large for this drive.'
					});
				}
				const result =
					size > caps.maxUploadBytes
						? yield* stagedUpload(
								client,
								config,
								prepared,
								contentType,
								size,
								isPrivate,
								expires
							)
						: yield* oneShotUpload(
								client,
								config,
								prepared,
								contentType,
								isPrivate,
								expires
							);
				yield* printUpload(result);
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
).pipe(
	Command.withDescription('Upload a file (auto-stages files above the cap)')
);

export const list = Command.make('list', {}, () =>
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
					Effect.flatMap((response) =>
						decodeBody(FileListResponseSchema, response)
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

export const get = Command.make(
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
			const link = yield* decodeBody(
				FileContentLinkResponseSchema,
				linkResponse
			);
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

export const rename = Command.make(
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
			const result = yield* decodeBody(FileMutationResponseSchema, response);
			yield* emit(
				wantsJson()
					? result
					: `Renamed ${result.file.id} to ${result.file.displayName}`
			);
		})
).pipe(Command.withDescription('Rename a file'));

export const tagSet = Command.make(
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
			const result = yield* decodeBody(FileTagsResponseSchema, response);
			yield* emit(
				wantsJson()
					? result
					: `${result.file.displayName}: ${result.file.tags.map((tag) => tag.name).join(', ')}`
			);
		})
).pipe(Command.withDescription('Replace all tags assigned to a file'));
