import { Cause, Effect, Exit } from 'effect';
import { describe, expect, it } from 'vitest';
import { InvalidRequest } from './errors';
import { readBoundedJson } from './request-json';

const options = {
	maxBytes: 8,
	invalidLengthMessage: 'Body length is invalid',
	invalidJsonMessage: 'JSON is required'
};

const readFailure = async (request: Request) => {
	const exit = await Effect.runPromiseExit(readBoundedJson(request, options));
	if (Exit.isSuccess(exit)) {
		throw new Error('Expected bounded JSON decoding to fail');
	}
	for (const reason of exit.cause.reasons) {
		if (Cause.isFailReason(reason) && reason.error instanceof InvalidRequest) {
			return reason.error;
		}
	}
	throw new Error('Expected an InvalidRequest failure');
};

describe('bounded JSON requests', () => {
	it('rejects actual bytes beyond the limit when Content-Length is false', async () => {
		const failure = await readFailure(
			new Request('https://drive.example.com/api/sites/sessions', {
				method: 'POST',
				headers: { 'content-length': '6' },
				body: '"😀😀"'
			})
		);

		expect(failure).toMatchObject({
			status: 413,
			message: 'Body length is invalid'
		});
	});

	it('preserves missing and invalid Content-Length statuses', async () => {
		const missing = await readFailure(
			new Request('https://drive.example.com/api/sites/sessions', {
				method: 'POST',
				body: '{}'
			})
		);
		const invalid = await readFailure(
			new Request('https://drive.example.com/api/sites/sessions', {
				method: 'POST',
				headers: { 'content-length': 'invalid' },
				body: '{}'
			})
		);

		expect(missing.status).toBe(411);
		expect(invalid.status).toBe(400);
	});

	it('accepts valid JSON whose actual bytes are exactly at the limit', async () => {
		const json = '{"a":12}';
		const request = new Request(
			'https://drive.example.com/api/sites/sessions',
			{
				method: 'POST',
				headers: { 'content-length': String(json.length) },
				body: json
			}
		);

		await expect(
			Effect.runPromise(readBoundedJson(request, options))
		).resolves.toEqual({ a: 12 });
	});

	it('keeps malformed bodies as typed bad requests', async () => {
		const failure = await readFailure(
			new Request('https://drive.example.com/api/sites/sessions', {
				method: 'POST',
				headers: { 'content-length': '1' },
				body: '{'
			})
		);

		expect(failure).toMatchObject({
			status: 400,
			message: 'JSON is required'
		});
	});

	it('keeps unreadable streams as typed bad requests', async () => {
		const request = new Request(
			'https://drive.example.com/api/sites/sessions',
			{
				method: 'POST',
				headers: { 'content-length': '2' },
				body: '{}'
			}
		);
		const reader = request.body?.getReader();
		if (reader === undefined) {
			throw new Error('Expected the request to have a body');
		}

		const failure = await readFailure(request);
		await reader.cancel();

		expect(failure).toMatchObject({
			status: 400,
			message: 'JSON is required'
		});
	});
});
