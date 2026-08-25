import type { DashboardFile } from '@adrive/shared';
import { McpServer } from '@modelcontextprotocol/server';
import { Effect } from 'effect';
import { z } from 'zod';
import { validateExpiration } from '../auth-policy';
import { AppConfig } from '../config';
import { InvalidRequest, validate } from '../errors';
import { maxPreviewBytes, previewKind } from '../file-preview';
import { resolveFileContentLink } from '../file-content-link';
import type { AuthorizedCredential } from '../services/auth';
import {
	assertFileInScope,
	assertUnrestricted,
	filterFilesByScope
} from '../token-scope';
import { AuthGuard } from '../services/auth-guard';
import { Blobs } from '../services/blobs';
import { Files } from '../services/files';
import { Indexing } from '../services/indexing';
import { Search } from '../services/search';
import { Shares } from '../services/shares';
import { Sites } from '../services/sites';
import { Tags } from '../services/tags';
import type { AppServices } from '../edge';
import { errorResult, jsonResult } from './result';
import {
	MCP_MAX_SITE_TOTAL_BYTES,
	MCP_MAX_UPLOAD_BYTES,
	MCP_STATUS_PAGE_CAP,
	MCP_STATUS_PAGE_SIZE,
	bytesToStream,
	decodeExclusiveContent,
	mcpPageLimit
} from './payload';
import { runMcp, scheduleIndex } from './run';

export const READ_TOOL_NAMES = [
	'whoami',
	'status',
	'list_files',
	'search_files',
	'get_file',
	'list_tags',
	'list_shares'
] as const;

export const WRITE_TOOL_NAMES = [
	'put_file',
	'rename_file',
	'create_tag',
	'update_tag',
	'delete_tag',
	'set_file_tags',
	'publish_site',
	'publish_files_site',
	'create_share',
	'revoke_share'
] as const;

export interface McpServerInput {
	readonly env: Env;
	readonly ctx: ExecutionContext;
	readonly credential: AuthorizedCredential;
}

const toolValue = async <A, E>(
	env: Env,
	program: Effect.Effect<A, E, AppServices>
) => {
	const result = await runMcp(env, program);
	return result.ok
		? jsonResult(result.value)
		: errorResult(result.message, result.status);
};

const fileIsLive = (
	file: {
		readonly deletedAt: string | null;
		readonly expiresAt: string | null;
	},
	now: string
) =>
	file.deletedAt === null && (file.expiresAt === null || file.expiresAt > now);

export const createAdriveMcpServer = (input: McpServerInput) => {
	const server = new McpServer({
		name: 'adrive',
		version: '0.1.0'
	});
	registerReadTools(server, input);
	if (input.credential.scope === 'read-write') {
		registerWriteTools(server, input);
	}
	return server;
};

const registerReadTools = (server: McpServer, input: McpServerInput) => {
	const { env, credential } = input;

	server.registerTool(
		'whoami',
		{
			description: 'Show the API key kind and scope for this request',
			inputSchema: z.object({})
		},
		async () =>
			toolValue(
				env,
				Effect.gen(function* () {
					const config = yield* AppConfig;
					return {
						kind: credential.kind,
						scope: credential.scope,
						credentialId: credential.credentialId,
						allowedTagIds: credential.restriction.tagIds,
						allowedFileIds: credential.restriction.fileIds,
						dashboardOrigin: config.dashboardOrigin,
						contentOrigin: config.contentOrigin
					};
				})
			)
	);

	server.registerTool(
		'status',
		{
			description: 'Show drive usage, tag count, and search status',
			inputSchema: z.object({})
		},
		async () =>
			toolValue(
				env,
				Effect.gen(function* () {
					const files = yield* Files;
					const tags = yield* Tags;
					const indexing = yield* Indexing;
					const config = yield* AppConfig;
					let cursor: string | null = null;
					let pages = 0;
					let fileCount = 0;
					let siteCount = 0;
					let publicFiles = 0;
					let totalBytes = 0;
					do {
						const page: {
							readonly files: ReadonlyArray<DashboardFile>;
							readonly nextCursor: string | null;
						} = yield* files.list(false, {
							cursor,
							limit: MCP_STATUS_PAGE_SIZE
						});
						for (const item of filterFilesByScope(credential, page.files)) {
							if (item.kind === 'site') {
								siteCount += 1;
							} else {
								fileCount += 1;
								if (item.public) publicFiles += 1;
							}
							totalBytes += item.sizeBytes;
						}
						cursor = page.nextCursor;
						pages += 1;
					} while (cursor !== null && pages < MCP_STATUS_PAGE_CAP);
					if (cursor !== null) {
						return yield* new InvalidRequest({
							status: 400,
							message: `Listing stopped after ${MCP_STATUS_PAGE_CAP} pages with more remaining`
						});
					}
					return {
						connected: true,
						files: fileCount,
						sites: siteCount,
						publicFiles,
						privateFiles: fileCount - publicFiles,
						totalBytes,
						tags: (yield* tags.list).length,
						maxUploadBytes: config.maxUploadBytes,
						maxStagedUploadBytes: config.maxStagedUploadBytes,
						mcpMaxUploadBytes: MCP_MAX_UPLOAD_BYTES,
						contentOrigin: config.contentOrigin,
						semantic: yield* indexing.status
					};
				})
			)
	);

	server.registerTool(
		'list_files',
		{
			description: 'List live files and sites',
			inputSchema: z.object({
				cursor: z.string().optional(),
				limit: z.number().int().optional()
			})
		},
		async ({ cursor, limit }) =>
			toolValue(
				env,
				Effect.gen(function* () {
					const files = yield* Files;
					const page = {
						cursor: cursor ?? null,
						limit: yield* validate(() => mcpPageLimit(limit))
					};
					const listing = yield* files.list(false, page);
					return {
						files: filterFilesByScope(credential, listing.files),
						nextCursor: listing.nextCursor
					};
				})
			)
	);

	server.registerTool(
		'search_files',
		{
			description: 'Search live files by query and optional tag ids',
			inputSchema: z.object({
				query: z.string(),
				tag_ids: z.array(z.string()).optional(),
				cursor: z.string().optional()
			})
		},
		async ({ query, tag_ids, cursor }) =>
			toolValue(
				env,
				Effect.gen(function* () {
					const search = yield* Search;
					const page = yield* search.files({
						query,
						tagIds: (tag_ids ?? []).slice(0, 20),
						cursor: cursor ?? null
					});
					return {
						files: filterFilesByScope(credential, page.files),
						nextCursor: page.nextCursor
					};
				})
			)
	);

	server.registerTool(
		'get_file',
		{
			description:
				'Get file or site metadata and a content URL. Set include_text to read a small text prefix.',
			inputSchema: z.object({
				id: z.string(),
				include_text: z.boolean().optional()
			})
		},
		async ({ id, include_text }) =>
			toolValue(
				env,
				Effect.gen(function* () {
					const files = yield* Files;
					const blobs = yield* Blobs;
					const config = yield* AppConfig;
					yield* assertFileInScope(credential, id);
					const detail = yield* files.detail(id);
					const now = new Date().toISOString();
					if (!fileIsLive(detail.file, now)) {
						return {
							file: detail.file,
							url: null,
							expiresAt: null,
							public: detail.file.public
						};
					}
					if (detail.file.kind === 'site') {
						return {
							file: detail.file,
							url: `${config.contentOrigin}/s/${detail.file.id}/`,
							expiresAt: null,
							public: true
						};
					}
					const link = yield* resolveFileContentLink(id);
					if (include_text !== true) {
						return { file: detail.file, ...link };
					}
					const kind = previewKind(
						detail.file.displayName,
						detail.file.contentType
					);
					if (kind === null) {
						return { file: detail.file, ...link };
					}
					const content = yield* files.findContent(id);
					const text = yield* blobs.readTextPrefix(
						content.r2Key,
						maxPreviewBytes
					);
					return {
						file: detail.file,
						...link,
						text,
						truncated: detail.file.sizeBytes > maxPreviewBytes
					};
				})
			)
	);

	server.registerTool(
		'list_tags',
		{
			description: 'List tags',
			inputSchema: z.object({})
		},
		async () =>
			toolValue(
				env,
				Effect.gen(function* () {
					const tags = yield* Tags;
					return { tags: yield* tags.list };
				})
			)
	);

	server.registerTool(
		'list_shares',
		{
			description: 'List durable private share links for a file',
			inputSchema: z.object({ file_id: z.string() })
		},
		async ({ file_id }) =>
			toolValue(
				env,
				Effect.gen(function* () {
					const shares = yield* Shares;
					yield* assertFileInScope(credential, file_id);
					return { shares: yield* shares.list(file_id) };
				})
			)
	);
};

const registerWriteTools = (server: McpServer, input: McpServerInput) => {
	const { env, ctx, credential } = input;

	server.registerTool(
		'put_file',
		{
			description:
				'Upload a file from text or base64. MCP uploads are capped at 2 MiB.',
			inputSchema: z.object({
				name: z.string(),
				text: z.string().optional(),
				content_base64: z.string().optional(),
				content_type: z.string().optional(),
				public: z.boolean().optional(),
				tags: z.array(z.string()).optional(),
				expires_at: z.string().nullable().optional()
			})
		},
		async (args) => {
			const decoded = decodeExclusiveContent(args);
			if (!decoded.ok) return errorResult(decoded.message, decoded.status);
			const uploaded = await runMcp(
				env,
				Effect.gen(function* () {
					const authGuard = yield* AuthGuard;
					const files = yield* Files;
					const config = yield* AppConfig;
					yield* assertUnrestricted(credential);
					const rate = yield* authGuard.consume(
						'upload',
						credential.credentialId
					);
					if (!rate.allowed) {
						return {
							kind: 'rate-limit' as const,
							message: 'Too many uploads. Try again later.'
						};
					}
					const expiresAt = yield* validate(() =>
						args.expires_at === undefined
							? null
							: validateExpiration(args.expires_at)
					);
					const result = yield* files.upload({
						displayName: args.name,
						contentType:
							args.content_type ??
							(args.text !== undefined
								? 'text/plain'
								: 'application/octet-stream'),
						public: args.public ?? true,
						contentLength: String(decoded.bytes.byteLength),
						body: bytesToStream(decoded.bytes),
						tags: args.tags ?? [],
						expiresAt
					});
					return {
						kind: 'ok' as const,
						file: result.file,
						url: `${config.contentOrigin}/f/${result.file.id}`,
						forcedPublic: result.forcedPublic
					};
				})
			);
			if (!uploaded.ok) return errorResult(uploaded.message, uploaded.status);
			if (uploaded.value.kind === 'rate-limit') {
				return errorResult(uploaded.value.message, 429);
			}
			scheduleIndex(env, ctx, uploaded.value.file.id);
			const { kind: _kind, ...value } = uploaded.value;
			return jsonResult(value);
		}
	);

	server.registerTool(
		'rename_file',
		{
			description: 'Rename a file or site',
			inputSchema: z.object({
				id: z.string(),
				display_name: z.string()
			})
		},
		async ({ id, display_name }) => {
			const result = await runMcp(
				env,
				Effect.gen(function* () {
					const files = yield* Files;
					yield* assertFileInScope(credential, id);
					return yield* files.rename(id, display_name);
				})
			);
			if (!result.ok) return errorResult(result.message, result.status);
			scheduleIndex(env, ctx, result.value.file.id);
			return jsonResult(result.value);
		}
	);

	server.registerTool(
		'create_tag',
		{
			description: 'Create a tag',
			inputSchema: z.object({
				name: z.string(),
				color: z.string().nullable().optional()
			})
		},
		async ({ name, color }) =>
			toolValue(
				env,
				Effect.gen(function* () {
					const tags = yield* Tags;
					yield* assertUnrestricted(credential);
					return { tag: yield* tags.create({ name, color }) };
				})
			)
	);

	server.registerTool(
		'update_tag',
		{
			description: 'Update a tag name or color',
			inputSchema: z.object({
				id: z.string(),
				name: z.string().optional(),
				color: z.string().nullable().optional()
			})
		},
		async ({ id, name, color }) =>
			toolValue(
				env,
				Effect.gen(function* () {
					const tags = yield* Tags;
					yield* assertUnrestricted(credential);
					return { tag: yield* tags.update(id, { name, color }) };
				})
			)
	);

	server.registerTool(
		'delete_tag',
		{
			description: 'Delete a tag',
			inputSchema: z.object({
				id: z.string()
			})
		},
		async ({ id }) =>
			toolValue(
				env,
				Effect.gen(function* () {
					const tags = yield* Tags;
					yield* assertUnrestricted(credential);
					yield* tags.remove(id);
					return { ok: true as const, id };
				})
			)
	);

	server.registerTool(
		'set_file_tags',
		{
			description: 'Replace all tags on a file',
			inputSchema: z.object({
				file_id: z.string(),
				names: z.array(z.string())
			})
		},
		async ({ file_id, names }) =>
			toolValue(
				env,
				Effect.gen(function* () {
					const tags = yield* Tags;
					const files = yield* Files;
					yield* assertFileInScope(credential, file_id);
					yield* tags.setFileTags(file_id, names);
					return { file: (yield* files.detail(file_id)).file };
				})
			)
	);

	server.registerTool(
		'publish_site',
		{
			description:
				'Publish a static site from inline assets. Each asset is capped at 2 MiB.',
			inputSchema: z.object({
				display_name: z.string(),
				file_id: z.string().optional(),
				assets: z.array(
					z.object({
						path: z.string(),
						text: z.string().optional(),
						content_base64: z.string().optional(),
						content_type: z.string().optional()
					})
				)
			})
		},
		async (args) => {
			const decoded: Array<{
				path: string;
				bytes: Uint8Array;
				contentType: string;
			}> = [];
			let totalBytes = 0;
			for (const asset of args.assets) {
				const content = decodeExclusiveContent(asset);
				if (!content.ok) {
					return errorResult(
						`${asset.path}: ${content.message}`,
						content.status
					);
				}
				totalBytes += content.bytes.byteLength;
				if (totalBytes > MCP_MAX_SITE_TOTAL_BYTES) {
					return errorResult('Site assets exceed the 8 MiB MCP total', 413);
				}
				decoded.push({
					path: asset.path,
					bytes: content.bytes,
					contentType: asset.content_type ?? 'application/octet-stream'
				});
			}
			const published = await runMcp(
				env,
				Effect.gen(function* () {
					const authGuard = yield* AuthGuard;
					const sites = yield* Sites;
					const config = yield* AppConfig;
					yield* assertUnrestricted(credential);
					const rate = yield* authGuard.consume(
						'upload',
						credential.credentialId
					);
					if (!rate.allowed) {
						return {
							kind: 'rate-limit' as const,
							message: 'Too many uploads. Try again later.'
						};
					}
					const session = yield* sites.createSession({
						displayName: args.display_name,
						...(args.file_id !== undefined ? { fileId: args.file_id } : {}),
						assets: decoded.map((asset) => ({
							path: asset.path,
							sizeBytes: asset.bytes.byteLength,
							contentType: asset.contentType
						}))
					});
					const committed = yield* Effect.gen(function* () {
						for (const asset of decoded) {
							yield* sites.stageAsset({
								sessionId: session.sessionId,
								path: asset.path,
								contentLength: String(asset.bytes.byteLength),
								body: bytesToStream(asset.bytes)
							});
						}
						return yield* sites.commit(session.sessionId);
					}).pipe(
						Effect.catch((failure) =>
							sites.abort(session.sessionId).pipe(
								Effect.catch(() => Effect.void),
								Effect.andThen(Effect.fail(failure))
							)
						)
					);
					return {
						kind: 'ok' as const,
						file: committed.file,
						url: `${config.contentOrigin}/s/${committed.file.id}/`,
						assetCount: committed.assetCount,
						cleanupPending: committed.cleanupPending
					};
				})
			);
			if (!published.ok)
				return errorResult(published.message, published.status);
			if (published.value.kind === 'rate-limit') {
				return errorResult(published.value.message, 429);
			}
			scheduleIndex(env, ctx, published.value.file.id);
			const { kind: _kind, ...value } = published.value;
			return jsonResult(value);
		}
	);

	server.registerTool(
		'publish_files_site',
		{
			description:
				'Publish files already in the drive as a site without re-uploading bytes. Provide file_ids and/or a tag_id; when no index.html is among them a gallery/listing is generated. Pass file_id to republish an existing site.',
			inputSchema: z.object({
				display_name: z.string().optional(),
				file_id: z.string().optional(),
				file_ids: z.array(z.string()).optional(),
				tag_id: z.string().optional()
			})
		},
		async ({ display_name, file_id, file_ids, tag_id }) => {
			const published = await runMcp(
				env,
				Effect.gen(function* () {
					const sites = yield* Sites;
					const config = yield* AppConfig;
					yield* assertUnrestricted(credential);
					const result = yield* sites.publishFromFiles({
						...(display_name !== undefined ? { displayName: display_name } : {}),
						...(file_id !== undefined ? { fileId: file_id } : {}),
						...(file_ids !== undefined ? { fileIds: file_ids } : {}),
						...(tag_id !== undefined ? { tagId: tag_id } : {})
					});
					return {
						file: result.file,
						url: `${config.contentOrigin}/s/${result.file.id}/`,
						assetCount: result.assetCount,
						cleanupPending: result.cleanupPending
					};
				})
			);
			if (!published.ok) return errorResult(published.message, published.status);
			scheduleIndex(env, ctx, published.value.file.id);
			return jsonResult(published.value);
		}
	);

	server.registerTool(
		'create_share',
		{
			description:
				'Create a durable private link for a file: a revocable URL that works on the content origin, follows the current version, and can carry a password and expiry (default 7 days).',
			inputSchema: z.object({
				file_id: z.string(),
				password: z.string().nullable().optional(),
				expires_in_days: z.number().nullable().optional(),
				label: z.string().nullable().optional()
			})
		},
		async ({ file_id, password, expires_in_days, label }) =>
			toolValue(
				env,
				Effect.gen(function* () {
					const shares = yield* Shares;
					yield* assertFileInScope(credential, file_id);
					const created = yield* shares.create(file_id, {
						password: password ?? null,
						expiresInDays: expires_in_days,
						label: label ?? null
					});
					return { share: created.share, url: created.url };
				})
			)
	);

	server.registerTool(
		'revoke_share',
		{
			description: 'Revoke a durable private link by share id',
			inputSchema: z.object({ file_id: z.string(), share_id: z.string() })
		},
		async ({ file_id, share_id }) =>
			toolValue(
				env,
				Effect.gen(function* () {
					const shares = yield* Shares;
					yield* assertFileInScope(credential, file_id);
					yield* shares.revoke(file_id, share_id);
					return { ok: true as const, id: share_id };
				})
			)
	);
};
