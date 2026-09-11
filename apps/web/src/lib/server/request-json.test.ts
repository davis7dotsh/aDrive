import { Cause, Effect, Exit } from 'effect';
import { describe, expect, it } from 'vitest';
import { InvalidRequest } from './errors';
import { readBoundedJson, readBoundedText } from './request-json';

const options = {
	maxBytes: 8,
	invalidLengthMessage: 'Body length is invalid',
	invalidJsonMessage: 'JSON is required'
};

const requestFailure = async (
	program: Effect.Effect<unknown, InvalidRequest>
) => {
	const exit = await Effect.runPromiseExit(program);
	if (Exit.isSuccess(exit)) {
		throw new Error('Expected bounded body reading to fail');
	}
	for (const reason of exit.cause.reasons) {
		if (Cause.isFailReason(reason) && reason.error instanceof InvalidRequest) {
			return reason.error;
		}
	}
	throw new Error('Expected an InvalidRequest failure');
};

const readFailure = (request: Request) =>
	requestFailure(readBoundedJson(request, options));

describe('bounded text requests', () => {
	const textOptions = {
		maxBytes: options.maxBytes,
		invalidLengthMessage: options.invalidLengthMessage,
		invalidTextMessage: 'Text body is unreadable'
	};

	it('preserves raw whitespace and accepts exactly the UTF-8 byte limit', async () => {
		for (const body of [' \n😀\t ', '😀😀']) {
			const request = new Request(
				'https://drive.example.com/api/internal/jobs',
				{
					method: 'POST',
					body
				}
			);
			await expect(
				Effect.runPromise(readBoundedText(request, textOptions))
			).resolves.toBe(body);
		}
	});

	it('rejects excess UTF-8 bytes even when the character count fits', async () => {
		const request = new Request('https://drive.example.com/api/internal/jobs', {
			method: 'POST',
			headers: { 'content-length': '5' },
			body: '😀😀a'
		});
		expect(
			await requestFailure(readBoundedText(request, textOptions))
		).toMatchObject({
			status: 413,
			message: options.invalidLengthMessage
		});
	});

	it('cancels an oversized stream without pulling its remaining chunks', async () => {
		const chunks = ['1234', '56789', 'never read'].map((value) =>
			new TextEncoder().encode(value)
		);
		let pulls = 0;
		let cancelled = false;
		const stream = new ReadableStream<Uint8Array>(
			{
				pull(controller) {
					const chunk = chunks[pulls++];
					if (chunk) controller.enqueue(chunk);
					else controller.close();
				},
				cancel() {
					cancelled = true;
				}
			},
			{ highWaterMark: 0 }
		);
		const init = { method: 'POST', body: stream, duplex: 'half' };
		const request = new Request(
			'https://drive.example.com/api/internal/jobs',
			init
		);
		expect(
			await requestFailure(readBoundedText(request, textOptions))
		).toMatchObject({ status: 413 });
		expect(cancelled).toBe(true);
		expect(pulls).toBe(2);
		expect(stream.locked).toBe(false);
	});
});

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

	it('accepts a valid body without Content-Length, still bounded', async () => {
		const accepted = await Effect.runPromise(
			readBoundedJson(
				new Request('https://drive.example.com/api/sites/sessions', {
					method: 'POST',
					body: '{}'
				}),
				options
			)
		);
		expect(accepted).toEqual({});

		const oversized = await readFailure(
			new Request('https://drive.example.com/api/sites/sessions', {
				method: 'POST',
				body: '{"key":"too large"}'
			})
		);
		expect(oversized.status).toBe(413);
	});

	it('rejects an invalid Content-Length header', async () => {
		const invalid = await readFailure(
			new Request('https://drive.example.com/api/sites/sessions', {
				method: 'POST',
				headers: { 'content-length': 'invalid' },
				body: '{}'
			})
		);

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
