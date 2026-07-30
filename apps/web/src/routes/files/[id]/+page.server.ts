import { FileDetailResponseSchema } from '@adrive/shared';
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
	return `Could not load the file (${response.status})`;
};

export const load: PageServerLoad = async ({ depends, fetch, params }) => {
	depends(`adrive:file:${params.id}`);
	let response: Response;
	try {
		response = await fetch(`/api/files/${encodeURIComponent(params.id)}`);
	} catch {
		return {
			initialDetail: null,
			initialError: 'Could not load the file'
		};
	}
	if (response.status === 401) {
		return { initialDetail: null, initialError: '' };
	}
	if (!response.ok) {
		return { initialDetail: null, initialError: await readError(response) };
	}
	try {
		return {
			initialDetail: await Schema.decodeUnknownPromise(
				FileDetailResponseSchema
			)(await response.json()),
			initialError: ''
		};
	} catch {
		return {
			initialDetail: null,
			initialError: 'The server returned invalid file data'
		};
	}
};
