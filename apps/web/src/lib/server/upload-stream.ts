import { InvalidRequest, StorageError } from './errors';

export interface UploadBucket {
	put(
		key: string,
		value: ReadableStream<Uint8Array>,
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
	makeFixedLengthStream = defaultFixedLengthStream
) => {
	const { readable, writable } = makeFixedLengthStream(size);
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
