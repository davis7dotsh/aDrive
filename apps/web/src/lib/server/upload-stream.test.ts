import { describe, expect, it } from 'vitest';
import { InvalidRequest } from './errors';
import {
	streamIntoBucket,
	validateUploadLength,
	type FixedLengthStreamFactory,
	type UploadBucket
} from './upload-stream';

const testFixedLengthStream: FixedLengthStreamFactory = () =>
	new TransformStream();

const source = (bytes: Uint8Array) =>
	new ReadableStream<Uint8Array>({
		start(controller) {
			controller.enqueue(bytes);
			controller.close();
		}
	});

describe('upload streaming', () => {
	it('requires and validates Content-Length before a body is consumed', () => {
		expect(() => validateUploadLength(null, 100)).toThrow(
			expect.objectContaining({ _tag: 'InvalidRequest', status: 411 })
		);
		expect(() => validateUploadLength('not-a-number', 100)).toThrow(
			expect.objectContaining({ _tag: 'InvalidRequest', status: 400 })
		);
		expect(() => validateUploadLength('101', 100)).toThrow(
			expect.objectContaining({ _tag: 'InvalidRequest', status: 413 })
		);
		expect(validateUploadLength('0', 100)).toBe(0);
	});

	it('starts the R2 reader concurrently with the pump', async () => {
		let putStarted = false;
		let stored = 0;
		const bucket = {
			async put(_key, readable) {
				putStarted = true;
				const reader = readable.getReader();
				while (true) {
					const next = await reader.read();
					if (next.done) break;
					stored += next.value.byteLength;
				}
				return { size: stored, httpEtag: '"etag"' };
			}
		} satisfies UploadBucket;

		const result = await streamIntoBucket(
			bucket,
			'opaque-key',
			source(new Uint8Array([1, 2, 3, 4])),
			4,
			'application/octet-stream',
			testFixedLengthStream
		);

		expect(putStarted).toBe(true);
		expect(result).toEqual({ size: 4, etag: '"etag"' });
	});

	it('supports a zero-byte upload without synthesizing buffered bytes', async () => {
		const bucket = {
			async put(_key, readable) {
				const reader = readable.getReader();
				const first = await reader.read();
				expect(first.done).toBe(true);
				return { size: 0, httpEtag: '"empty"' };
			}
		} satisfies UploadBucket;

		await expect(
			streamIntoBucket(
				bucket,
				'empty-key',
				null,
				0,
				'application/octet-stream',
				testFixedLengthStream
			)
		).resolves.toEqual({ size: 0, etag: '"empty"' });
	});

	it('keeps upload validation failures typed', () => {
		try {
			validateUploadLength(null, 1);
			expect.unreachable();
		} catch (cause) {
			expect(cause).toBeInstanceOf(InvalidRequest);
		}
	});
});
