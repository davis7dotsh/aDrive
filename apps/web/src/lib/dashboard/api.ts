import type {
	FileContentLinkResponse,
	FileDetailResponse,
	FileListResponse,
	FileMutation,
	Tag,
	TagCreate,
	TagUpdate
} from '@adrive/shared';
import {
	parseApiKeyCreateResponse,
	parseApiKeyListResponse,
	parseFileContentLink,
	parseFileDetailResponse,
	parseFileListResponse,
	parseFileMutationResponse,
	parseFileTagsResponse,
	parseSessionsRevokedResponse,
	parseTagResponse,
	parseUploadResponse
} from './parse';

export const BROWSER_SESSION = '__browser_session__';

export type FileListPayload = FileListResponse;
export type FileDetailPayload = FileDetailResponse;

export class ApiError extends Error {
	constructor(
		message: string,
		readonly status: number
	) {
		super(message);
		this.name = 'ApiError';
	}
}

const errorMessage = async (response: Response) => {
	const fallback = `Request failed (${response.status})`;
	try {
		const body: unknown = await response.json();
		if (
			typeof body === 'object' &&
			body !== null &&
			'message' in body &&
			typeof body.message === 'string'
		) {
			return body.message;
		}
	} catch {
		return fallback;
	}
	return fallback;
};

const request = async (path: string, token: string, init?: RequestInit) => {
	const headers = new Headers(init?.headers);
	if (token !== BROWSER_SESSION) {
		headers.set('Authorization', `Bearer ${token}`);
	}
	const response = await fetch(path, {
		...init,
		headers,
		credentials: 'same-origin'
	});
	if (!response.ok) {
		throw new ApiError(await errorMessage(response), response.status);
	}
	return response;
};

const json = async <A>(parse: (value: unknown) => A, response: Response) =>
	parse(await response.json());

export const checkKey = async (token: string, signal?: AbortSignal) => {
	await request('/api/auth/check', token, { signal });
};

export const loginWithPasscode = async (passcode: string) => {
	await request('/api/auth/session', BROWSER_SESSION, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ passcode })
	});
};

export const logoutSession = async () => {
	await request('/api/auth/session', BROWSER_SESSION, { method: 'DELETE' });
};

export const logoutEverywhere = async (token: string) => {
	const response = await request('/api/auth/sessions', token, {
		method: 'DELETE'
	});
	return json(parseSessionsRevokedResponse, response);
};

export const listApiKeys = async (token: string, signal?: AbortSignal) => {
	const response = await request('/api/auth/keys', token, { signal });
	return (await json(parseApiKeyListResponse, response)).keys;
};

export const createApiKey = async (
	token: string,
	name: string,
	scope: 'read-only' | 'read-write' = 'read-write',
	options: {
		readonly expiresAt?: string | null;
		readonly allowedTagIds?: ReadonlyArray<string> | null;
		readonly allowedFileIds?: ReadonlyArray<string> | null;
	} = {}
) => {
	const response = await request('/api/auth/keys', token, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({
			name,
			scope,
			expiresAt: options.expiresAt ?? null,
			allowedTagIds: options.allowedTagIds ?? null,
			allowedFileIds: options.allowedFileIds ?? null
		})
	});
	return json(parseApiKeyCreateResponse, response);
};

export const revokeApiKey = async (token: string, id: string) => {
	await request(`/api/auth/keys/${encodeURIComponent(id)}`, token, {
		method: 'DELETE'
	});
};

export const approveDevice = async (token: string, userCode: string) => {
	await request('/api/auth/device/approve', token, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ userCode })
	});
};

export const denyDevice = async (token: string, userCode: string) => {
	await request('/api/auth/device/approve', token, {
		method: 'DELETE',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ userCode })
	});
};

export const listFiles = async (
	token: string,
	trashed: boolean,
	signal?: AbortSignal,
	cursor?: string
) => {
	const params = new URLSearchParams();
	if (trashed) params.set('trashed', 'true');
	if (cursor) {
		params.set('cursor', cursor);
		params.set('omitMeta', '1');
	}
	const response = await request(
		`/api/files${params.size > 0 ? `?${params}` : ''}`,
		token,
		{ signal }
	);
	return json(parseFileListResponse, response);
};

export const emptyTrash = async (token: string) => {
	await request('/api/files?trashed=true', token, { method: 'DELETE' });
};

export const searchFiles = async (
	token: string,
	query: string,
	tagIds: ReadonlyArray<string>,
	signal?: AbortSignal,
	cursor?: string
) => {
	const params = new URLSearchParams();
	if (query.trim()) params.set('q', query);
	for (const tagId of tagIds.slice(0, 20)) params.append('tag', tagId);
	if (cursor) {
		params.set('cursor', cursor);
		params.set('omitMeta', '1');
	}
	const response = await request(`/api/search?${params.toString()}`, token, {
		signal
	});
	return json(parseFileListResponse, response);
};

export const getFile = async (
	token: string,
	id: string,
	signal?: AbortSignal,
	versionsCursor?: string
) => {
	const params = new URLSearchParams();
	if (versionsCursor) params.set('versionsCursor', versionsCursor);
	const response = await request(
		`/api/files/${encodeURIComponent(id)}${params.size > 0 ? `?${params}` : ''}`,
		token,
		{
			signal
		}
	);
	return json(parseFileDetailResponse, response);
};

// Preview text is immutable per (file, version), and dashboard grids fetch
// it for every visible text file on every visit, so memoize it in memory for
// the session. Bounded so a session with many or large text files cannot
// balloon: entries are skipped past a size cap and evicted oldest-first.
const MAX_PREVIEW_CACHE_BYTES = 128 * 1024;
const MAX_PREVIEW_CACHE_ENTRIES = 200;
const previewCache = new Map<
	`${string}\u0000${number}`,
	{ kind: string; text: string }
>();

export const getFilePreview = async (
	token: string,
	id: string,
	version?: number,
	signal?: AbortSignal
) => {
	const cacheKey =
		version === undefined ? null : (`${id}\u0000${version}` as const);
	if (cacheKey !== null) {
		const cached = previewCache.get(cacheKey);
		if (cached) return { kind: cached.kind, text: cached.text };
	}
	const params = new URLSearchParams();
	if (version !== undefined) params.set('v', String(version));
	const response = await request(
		`/api/files/${encodeURIComponent(id)}/preview${params.size > 0 ? `?${params}` : ''}`,
		token,
		{ signal }
	);
	const kind = response.headers.get('X-Adrive-Preview-Kind') ?? 'text';
	const text = await response.text();
	if (cacheKey !== null && text.length <= MAX_PREVIEW_CACHE_BYTES) {
		previewCache.set(cacheKey, { kind, text });
		if (previewCache.size > MAX_PREVIEW_CACHE_ENTRIES) {
			const oldest = previewCache.keys().next().value;
			if (oldest !== undefined) previewCache.delete(oldest);
		}
	}
	return { kind, text };
};

// Signed private content links are expensive to mint (auth + D1 lookup +
// HMAC per call) and identical across calls for the same file version, so
// memoize them by scope with a safety margin. A dashboard grid can request
// dozens of private thumbnails at once; without this every one of them fires
// a separate /link request on every visit, which is the main pop-in source
// for private files. Links are short-lived, so entries are reused only until
// shortly before the server-side grant expires.
const PRIVATE_LINK_RENEW_MS = 60_000;
const MAX_PRIVATE_LINK_CACHE_ENTRIES = 200;
interface CachedPrivateLink {
	readonly expiresAt: number;
	readonly payload: FileContentLinkResponse;
}
const privateLinkCache = new Map<string, CachedPrivateLink>();
const privateLinkKey = (
	id: string,
	version: number | undefined,
	includeUnavailable: boolean,
	requireGrant: boolean
) =>
	`${id}\u0000${version ?? ''}\u0000${includeUnavailable ? 1 : 0}\u0000${requireGrant ? 1 : 0}`;

export const getContentLink = async (
	token: string,
	id: string,
	version?: number,
	signal?: AbortSignal,
	includeUnavailable = false,
	requireGrant = false
) => {
	const key = privateLinkKey(id, version, includeUnavailable, requireGrant);
	const cached = version === undefined ? undefined : privateLinkCache.get(key);
	if (cached && cached.expiresAt - Date.now() > PRIVATE_LINK_RENEW_MS) {
		return cached.payload;
	}
	const params = new URLSearchParams();
	if (version !== undefined) params.set('v', String(version));
	if (includeUnavailable) params.set('unavailable', 'true');
	if (requireGrant) params.set('grant', 'true');
	const response = await request(
		`/api/files/${encodeURIComponent(id)}/link${params.size > 0 ? `?${params}` : ''}`,
		token,
		{ signal }
	);
	const payload = json(parseFileContentLink, response);
	if (version !== undefined && !includeUnavailable) {
		// Only memoize still-available private grants; unavailable/trashed
		// links and versionless "current file" links are always checked
		// against the server so a new version cannot reuse a stale grant.
		const link = await payload;
		if (!link.public && link.expiresAt !== null) {
			const expiresAt = new Date(link.expiresAt).getTime();
			if (Number.isFinite(expiresAt)) {
				privateLinkCache.set(key, { expiresAt, payload: link });
				if (privateLinkCache.size > MAX_PRIVATE_LINK_CACHE_ENTRIES) {
					const oldest = privateLinkCache.keys().next().value;
					if (oldest !== undefined) privateLinkCache.delete(oldest);
				}
			}
		}
		return link;
	}
	return payload;
};

type UploadOptions = {
	readonly onProgress?: (uploaded: number, total: number) => void;
	readonly signal?: AbortSignal;
};

export const uploadFile = async (
	token: string,
	file: File,
	isPublic: boolean,
	tagNames: ReadonlyArray<string> = [],
	expiresAt: string | null = null,
	options: UploadOptions = {}
) => {
	const body = await new Promise<unknown>((resolve, reject) => {
		const xhr = new XMLHttpRequest();
		const abort = () => xhr.abort();
		const finish = () => options.signal?.removeEventListener('abort', abort);
		xhr.open('PUT', '/api/files');
		xhr.withCredentials = true;
		xhr.setRequestHeader(
			'Content-Type',
			file.type || 'application/octet-stream'
		);
		xhr.setRequestHeader('X-Adrive-File-Name', encodeURIComponent(file.name));
		xhr.setRequestHeader('X-Adrive-Public', String(isPublic));
		xhr.setRequestHeader(
			'X-Adrive-Tags',
			encodeURIComponent(JSON.stringify(tagNames))
		);
		if (expiresAt) xhr.setRequestHeader('X-Adrive-Expires-At', expiresAt);
		if (token !== BROWSER_SESSION) {
			xhr.setRequestHeader('Authorization', `Bearer ${token}`);
		}
		xhr.upload.onprogress = (event) => {
			options.onProgress?.(
				event.loaded,
				event.lengthComputable ? event.total : file.size
			);
		};
		xhr.onload = () => {
			finish();
			let parsed: unknown;
			try {
				parsed = JSON.parse(xhr.responseText);
			} catch {
				reject(new Error(`Request failed (${xhr.status})`));
				return;
			}
			if (xhr.status >= 200 && xhr.status < 300) {
				resolve(parsed);
				return;
			}
			const message =
				typeof parsed === 'object' &&
				parsed !== null &&
				'message' in parsed &&
				typeof parsed.message === 'string'
					? parsed.message
					: `Request failed (${xhr.status})`;
			reject(new Error(message));
		};
		xhr.onerror = () => {
			finish();
			reject(new Error('Upload failed because the network connection ended'));
		};
		xhr.onabort = () => {
			finish();
			reject(new DOMException('Upload cancelled', 'AbortError'));
		};
		options.signal?.addEventListener('abort', abort, { once: true });
		if (options.signal?.aborted) {
			abort();
			return;
		}
		xhr.send(file);
	});
	return parseUploadResponse(body);
};

export const uploadVersion = async (token: string, id: string, file: File) => {
	const response = await request(
		`/api/files/${encodeURIComponent(id)}/versions`,
		token,
		{
			method: 'PUT',
			headers: {
				'Content-Type': file.type || 'application/octet-stream'
			},
			body: file
		}
	);
	return json(parseFileMutationResponse, response);
};

export const mutateFile = async (
	token: string,
	id: string,
	mutation: FileMutation
) => {
	const response = await request(
		`/api/files/${encodeURIComponent(id)}`,
		token,
		{
			method: 'PATCH',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify(mutation)
		}
	);
	return json(parseFileMutationResponse, response);
};

export const createTag = async (token: string, input: TagCreate) => {
	const response = await request('/api/tags', token, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify(input)
	});
	return (await json(parseTagResponse, response)).tag;
};

export const updateTag = async (
	token: string,
	id: string,
	input: TagUpdate
) => {
	const response = await request(`/api/tags/${encodeURIComponent(id)}`, token, {
		method: 'PATCH',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify(input)
	});
	return (await json(parseTagResponse, response)).tag;
};

export const deleteTag = async (token: string, id: string) => {
	await request(`/api/tags/${encodeURIComponent(id)}`, token, {
		method: 'DELETE'
	});
};

export const setFileTags = async (
	token: string,
	id: string,
	tags: ReadonlyArray<Pick<Tag, 'name'>>
) => {
	const response = await request(
		`/api/files/${encodeURIComponent(id)}/tags`,
		token,
		{
			method: 'PUT',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ names: tags.map((tag) => tag.name) })
		}
	);
	return (await json(parseFileTagsResponse, response)).file;
};
