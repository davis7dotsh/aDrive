import {
	ApiKeyCreateResponseSchema,
	ApiKeyListResponseSchema,
	FileContentLinkResponseSchema,
	FileDetailResponseSchema,
	FileListResponseSchema,
	FileMutationResponseSchema,
	FileTagsResponseSchema,
	TagResponseSchema,
	UploadResponseSchema,
	type FileContentLinkResponse,
	type FileDetailResponse,
	type FileListResponse,
	type FileMutation,
	type Tag,
	type TagCreate,
	type TagUpdate
} from '@adrive/shared';
import { Schema } from 'effect';

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

const json = async <A, I>(
	schema: Schema.Codec<A, I, never>,
	response: Response
) => Schema.decodeUnknownPromise(schema)(await response.json());

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

export const listApiKeys = async (token: string, signal?: AbortSignal) => {
	const response = await request('/api/auth/keys', token, { signal });
	return (await json(ApiKeyListResponseSchema, response)).keys;
};

export const createApiKey = async (
	token: string,
	name: string,
	scope: 'read-only' | 'read-write' = 'read-write'
) => {
	const response = await request('/api/auth/keys', token, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ name, scope })
	});
	return json(ApiKeyCreateResponseSchema, response);
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
	signal?: AbortSignal
) => {
	const response = await request(
		`/api/files${trashed ? '?trashed=true' : ''}`,
		token,
		{ signal }
	);
	return json(FileListResponseSchema, response);
};

export const emptyTrash = async (token: string) => {
	await request('/api/files?trashed=true', token, { method: 'DELETE' });
};

export const searchFiles = async (
	token: string,
	query: string,
	tagIds: ReadonlyArray<string>,
	signal?: AbortSignal
) => {
	const params = new URLSearchParams();
	if (query.trim()) params.set('q', query);
	for (const tagId of tagIds.slice(0, 20)) params.append('tag', tagId);
	const response = await request(`/api/search?${params.toString()}`, token, {
		signal
	});
	return json(FileListResponseSchema, response);
};

export const getFile = async (
	token: string,
	id: string,
	signal?: AbortSignal
) => {
	const response = await request(
		`/api/files/${encodeURIComponent(id)}`,
		token,
		{
			signal
		}
	);
	return json(FileDetailResponseSchema, response);
};

export const getFilePreview = async (
	token: string,
	id: string,
	signal?: AbortSignal
) => {
	const response = await request(
		`/api/files/${encodeURIComponent(id)}/preview`,
		token,
		{ signal }
	);
	return {
		kind: response.headers.get('X-Adrive-Preview-Kind') ?? 'text',
		text: await response.text()
	};
};

export const getContentLink = async (
	token: string,
	id: string,
	version?: number,
	signal?: AbortSignal,
	includeUnavailable = false
) => {
	const params = new URLSearchParams();
	if (version !== undefined) params.set('v', String(version));
	if (includeUnavailable) params.set('unavailable', 'true');
	const response = await request(
		`/api/files/${encodeURIComponent(id)}/link${params.size > 0 ? `?${params}` : ''}`,
		token,
		{ signal }
	);
	return json(
		FileContentLinkResponseSchema,
		response
	) satisfies Promise<FileContentLinkResponse>;
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
	return Schema.decodeUnknownPromise(UploadResponseSchema)(body);
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
	return json(FileMutationResponseSchema, response);
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
	return json(FileMutationResponseSchema, response);
};

export const createTag = async (token: string, input: TagCreate) => {
	const response = await request('/api/tags', token, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify(input)
	});
	return (await json(TagResponseSchema, response)).tag;
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
	return (await json(TagResponseSchema, response)).tag;
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
	return (await json(FileTagsResponseSchema, response)).file;
};
