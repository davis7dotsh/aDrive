import { Effect, Schema } from 'effect';
import {
	HttpBody,
	HttpClientRequest,
	HttpClientResponse
} from 'effect/unstable/http';
import { CliFailure } from './errors.ts';

export const apiRequest = (
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
			// Without an explicit accept, SvelteKit negotiates API errors
			// into HTML pages and their {message} never reaches the user.
			accept: 'application/json',
			authorization: `Bearer ${apiKey}`,
			...options.headers
		}
	});

// A friendly fallback when the server sends no {message} of its own.
const statusHint = (status: number) => {
	if (status === 401)
		return 'Not signed in or the credential was rejected. Run `adrive login <server-url>`.';
	if (status === 403) return 'This credential is not allowed to do that.';
	if (status === 404) return 'Not found.';
	if (status === 413) return 'That is too large for this drive.';
	if (status === 429) return 'Too many requests — wait a moment and retry.';
	if (status >= 500)
		return 'The server hit an unexpected error. Try again shortly.';
	if (status >= 400) return 'The request was rejected.';
	return `Unexpected response (${status}).`;
};

const messageFromBody = (body: string): string | undefined => {
	try {
		const value: unknown = JSON.parse(body);
		if (
			typeof value === 'object' &&
			value !== null &&
			'message' in value &&
			typeof value.message === 'string' &&
			value.message.trim() !== ''
		) {
			return value.message;
		}
	} catch {
		// Non-JSON body (e.g. an HTML error page); ignore.
	}
	return undefined;
};

// On any non-2xx, read the server's {message} and fail with a CliFailure
// carrying that hint plus a dimmed "METHOD url → status" detail line. The
// query string is dropped from the detail — private download URLs carry a
// signed access grant there that must never reach the terminal.
const redactUrl = (raw: string) => {
	try {
		const url = new URL(raw);
		return `${url.origin}${url.pathname}`;
	} catch {
		return raw.split('?')[0] ?? raw;
	}
};

export const ensureOk = (response: HttpClientResponse.HttpClientResponse) =>
	response.status >= 200 && response.status < 300
		? Effect.succeed(response)
		: response.text.pipe(
				Effect.orElseSucceed(() => ''),
				Effect.flatMap((body) =>
					Effect.fail(
						new CliFailure({
							message: messageFromBody(body) ?? statusHint(response.status),
							detail: `${response.request.method} ${redactUrl(response.request.url)} → ${response.status}`,
							status: response.status
						})
					)
				)
			);

// Decode a response body against a schema, turning a shape mismatch into a
// clean CliFailure instead of a raw ParseError.
export const decodeBody = <A, I>(
	schema: Schema.Codec<A, I, never>,
	response: HttpClientResponse.HttpClientResponse
) =>
	HttpClientResponse.schemaBodyJson(schema)(response).pipe(
		Effect.mapError(
			(cause) =>
				new CliFailure({
					message: 'The server returned an unexpected response.',
					detail: 'The response did not match the expected format.',
					cause
				})
		)
	);

// For raw fetch() call sites (device flow, upgrade): extract the server's
// error message or fall back to the friendly status hint.
export const responseError = async (response: Response) => {
	try {
		return (
			messageFromBody(await response.text()) ?? statusHint(response.status)
		);
	} catch {
		return statusHint(response.status);
	}
};
