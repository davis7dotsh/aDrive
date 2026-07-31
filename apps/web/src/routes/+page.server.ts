import { FileListResponseSchema } from '@adrive/shared';
import { Schema } from 'effect';
import type { PageServerLoad } from './$types';

const readError = async (response: Response) => {
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
		// The status fallback below is enough for non-JSON failures.
	}
	return `Could not load files (${response.status})`;
};

const tagIds = (url: URL) => {
	const value = url.searchParams.get('tags');
	if (!value) return [];
	try {
		const parsed: unknown = JSON.parse(value);
		return Array.isArray(parsed)
			? parsed.filter((tag): tag is string => typeof tag === 'string')
			: [];
	} catch {
		return [];
	}
};

export const load: PageServerLoad = async ({ depends, fetch, url }) => {
	depends('adrive:files');
	const trashed = url.searchParams.get('view') === 'trash';
	const params = new URLSearchParams();
	if (trashed) {
		params.set('trashed', 'true');
	} else {
		const query = url.searchParams.get('q')?.trim();
		if (query) params.set('q', query);
		for (const tag of tagIds(url).slice(0, 20)) {
			params.append('tag', tag);
		}
	}
	// Plain browsing pages through /api/files (mirroring the client resource);
	// queries and tag filters go to relevance-bounded search.
	const path = trashed
		? `/api/files?${params}`
		: params.size > 0
			? `/api/search?${params}`
			: '/api/files';
	let response: Response;
	try {
		response = await fetch(path);
	} catch {
		return {
			initialList: null,
			initialError: 'Could not load files'
		};
	}
	if (response.status === 401) {
		return { initialList: null, initialError: '' };
	}
	if (!response.ok) {
		return { initialList: null, initialError: await readError(response) };
	}
	try {
		return {
			initialList: await Schema.decodeUnknownPromise(FileListResponseSchema)(
				await response.json()
			),
			initialError: ''
		};
	} catch {
		return {
			initialList: null,
			initialError: 'The server returned invalid file data'
		};
	}
};
