import { InvalidRequest, StorageError } from './errors';

export interface UploadBucket {
	put(
		key: string,
		value: ReadableStream<Uint8Array> | ArrayBuffer,
		options: R2PutOptions
	): Promise<{ readonly size: number; readonly httpEtag: string } | null>;
}

export type FixedLengthStreamFactory = (size: number) => {
	readonly readable: ReadableStream<Uint8Array>;
	readonly writable: WritableStream<Uint8Array>;
};

export const validateUploadLength = (
	header: string | null,
	maxUploadBytes: number
) => {
	if (header === null) {
		throw new InvalidRequest({
			status: 411,
			message: 'Content-Length is required'
		});
	}
	const size = Number(header);
	if (!Number.isSafeInteger(size) || size < 0) {
		throw new InvalidRequest({
			status: 400,
			message: 'Content-Length is invalid'
		});
	}
	if (size > maxUploadBytes) {
		throw new InvalidRequest({
			status: 413,
			message: 'File exceeds the upload limit'
		});
	}
	return size;
};

const defaultFixedLengthStream: FixedLengthStreamFactory = (size) =>
	new FixedLengthStream(size);

export const streamIntoBucket = async (
	bucket: UploadBucket,
	key: string,
	body: ReadableStream<Uint8Array> | null,
	size: number,
	contentType: string,
	makeFixedLengthStream?: FixedLengthStreamFactory
) => {
	if (
		makeFixedLengthStream === undefined &&
		typeof FixedLengthStream === 'undefined'
	) {
		try {
			const value =
				body === null
					? new ArrayBuffer(0)
					: await new Response(body).arrayBuffer();
			if (value.byteLength !== size) {
				throw new StorageError({
					operation: 'stream blob',
					cause: new Error('Upload length changed while buffering locally')
				});
			}
			const object = await bucket.put(key, value, {
				httpMetadata: { contentType }
			});
			if (object === null) {
				throw new StorageError({
					operation: 'put blob',
					cause: new Error('R2 precondition failed')
				});
			}
			return { size: object.size, etag: object.httpEtag };
		} catch (cause) {
			if (cause instanceof StorageError) throw cause;
			throw new StorageError({ operation: 'stream blob', cause });
		}
	}

	const { readable, writable } = (
		makeFixedLengthStream ?? defaultFixedLengthStream
	)(size);
	const source =
		body ??
		new ReadableStream<Uint8Array>({
			start(controller) {
				controller.close();
			}
		});
	const pumped = source.pipeTo(writable);
	try {
		const [object] = await Promise.all([
			bucket.put(key, readable, { httpMetadata: { contentType } }),
			pumped
		]);
		if (object === null) {
			throw new StorageError({
				operation: 'put blob',
				cause: new Error('R2 precondition failed')
			});
		}
		return { size: object.size, etag: object.httpEtag };
	} catch (cause) {
		if (cause instanceof StorageError) throw cause;
		throw new StorageError({ operation: 'stream blob', cause });
	}
};
