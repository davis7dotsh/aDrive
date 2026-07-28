import type {
	FileDetailResponse,
	FileListResponse,
	FileMutation,
	FileMutationResponse,
	UploadResponse
} from '@adrive/shared';

export type FileListPayload = FileListResponse;
export type FileDetailPayload = FileDetailResponse;

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
	headers.set('Authorization', `Bearer ${token}`);
	const response = await fetch(path, { ...init, headers });
	if (!response.ok) throw new Error(await errorMessage(response));
	return response;
};

export const checkKey = async (token: string) => {
	await request('/api/auth/check', token);
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
	return (await response.json()) as FileListResponse;
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
	return (await response.json()) as FileDetailResponse;
};

export const uploadFile = async (
	token: string,
	file: File,
	isPublic: boolean
) => {
	const response = await request('/api/files', token, {
		method: 'PUT',
		headers: {
			'Content-Type': file.type || 'application/octet-stream',
			'X-Adrive-File-Name': encodeURIComponent(file.name),
			'X-Adrive-Public': String(isPublic)
		},
		body: file
	});
	return (await response.json()) as UploadResponse;
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
	return (await response.json()) as FileMutationResponse;
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
	return (await response.json()) as FileMutationResponse;
};
