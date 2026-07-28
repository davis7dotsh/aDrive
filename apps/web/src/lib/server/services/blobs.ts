import { Context, Effect, Layer } from 'effect';
import { NotFound, StorageError } from '../errors';
import { streamIntoBucket } from '../upload-stream';
import { Bucket } from './bindings';

export interface StoredBlob {
	readonly size: number;
	readonly etag: string;
}

export interface BlobsShape {
	readonly put: (
		key: string,
		body: ReadableStream<Uint8Array> | null,
		size: number,
		contentType: string
	) => Effect.Effect<StoredBlob, StorageError>;
	readonly get: (
		key: string
	) => Effect.Effect<R2ObjectBody, NotFound | StorageError>;
	readonly delete: (key: string) => Effect.Effect<void, StorageError>;
}

export class Blobs extends Context.Service<Blobs, BlobsShape>()('app/Blobs') {}

const makeBlobs = Effect.gen(function* () {
	const bucket = yield* Bucket;

	return Blobs.of({
		put: Effect.fn('Blobs.put')(function* (key, body, size, contentType) {
			return yield* Effect.tryPromise({
				try: () => streamIntoBucket(bucket, key, body, size, contentType),
				catch: (cause) =>
					cause instanceof StorageError
						? cause
						: new StorageError({ operation: 'put blob', cause })
			});
		}),
		get: Effect.fn('Blobs.get')(function* (key) {
			const object = yield* Effect.tryPromise({
				try: () => bucket.get(key),
				catch: (cause) => new StorageError({ operation: 'get blob', cause })
			});
			if (object === null) return yield* new NotFound({ id: key });
			return object;
		}),
		delete: Effect.fn('Blobs.delete')(function* (key) {
			yield* Effect.tryPromise({
				try: () => bucket.delete(key),
				catch: (cause) => new StorageError({ operation: 'delete blob', cause })
			});
		})
	});
});

export const BlobsLive = Layer.effect(Blobs, makeBlobs);
