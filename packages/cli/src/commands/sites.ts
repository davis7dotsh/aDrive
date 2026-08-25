import {
	normalizeSitePath,
	SiteAssetResponseSchema,
	SiteCommitResponseSchema,
	SiteSessionResponseSchema,
	type SiteManifestAsset
} from '@adrive/shared';
import { lstat, readdir, realpath } from 'node:fs/promises';
import { basename, join, relative, sep } from 'node:path';
import { Console, Effect, Option } from 'effect';
import { Argument, Command, Flag } from 'effect/unstable/cli';
import { HttpBody, HttpClient } from 'effect/unstable/http';
import mime from 'mime';
import { CliConfigSchema } from '../config-schema.ts';
import { loadConfig } from '../config.ts';
import { CliFailure } from '../errors.ts';
import { apiRequest, decodeBody, ensureOk } from '../http.ts';
import { emit, wantsJson } from '../output.ts';

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
		yield* decodeBody(SiteAssetResponseSchema, response);
	});

export const sitePut = Command.make(
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
			const session = yield* decodeBody(
				SiteSessionResponseSchema,
				createResponse
			);
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
			const result = yield* decodeBody(
				SiteCommitResponseSchema,
				commitResponse
			);
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

const splitIds = (value: Option.Option<string>): ReadonlyArray<string> =>
	Option.match(value, {
		onNone: () => [],
		onSome: (raw) =>
			raw
				.split(/[\s,]+/)
				.map((entry) => entry.trim())
				.filter((entry) => entry !== '')
	});

export const sitePublish = Command.make(
	'publish',
	{
		files: Flag.string('files').pipe(
			Flag.optional,
			Flag.withDescription('File IDs to publish (comma or space separated)')
		),
		tag: Flag.string('tag').pipe(
			Flag.optional,
			Flag.withDescription('Publish every file carrying this tag ID')
		),
		name: Flag.string('name').pipe(
			Flag.optional,
			Flag.withDescription('Display name for a new site')
		),
		id: Flag.string('id').pipe(
			Flag.optional,
			Flag.withDescription('Existing site UUID to republish')
		)
	},
	({ files, tag, name, id }) =>
		Effect.gen(function* () {
			const config = yield* loadConfig;
			const client = yield* HttpClient.HttpClient;
			const fileIds = splitIds(files);
			if (fileIds.length === 0 && Option.isNone(tag)) {
				return yield* new CliFailure({
					message: 'Provide --files and/or --tag to choose what to publish'
				});
			}
			const body: Record<string, unknown> = {};
			if (Option.isSome(name)) body.displayName = name.value;
			if (Option.isSome(id)) body.fileId = id.value;
			if (fileIds.length > 0) body.fileIds = fileIds;
			if (Option.isSome(tag)) body.tagId = tag.value;
			const response = yield* client
				.execute(
					apiRequest(
						'POST',
						`${config.endpoint}/api/sites/publish`,
						config.apiKey,
						{ body: HttpBody.jsonUnsafe(body) }
					)
				)
				.pipe(Effect.flatMap(ensureOk));
			const result = yield* decodeBody(SiteCommitResponseSchema, response);
			if (wantsJson()) {
				yield* emit(result);
			} else {
				yield* Console.log(`Published ${result.file.displayName}`);
				yield* Console.log(result.url);
				yield* Console.log(
					`${result.file.id} · ${result.assetCount} assets · v${result.file.version} · public`
				);
			}
		})
).pipe(
	Command.withDescription(
		'Publish existing drive files as a site (by file IDs and/or a tag)'
	)
);

export const site = Command.make('site').pipe(
	Command.withDescription('Publish static sites'),
	Command.withSubcommands([sitePut, sitePublish])
);
