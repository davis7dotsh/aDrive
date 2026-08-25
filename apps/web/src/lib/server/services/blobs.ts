import { Context, Effect, Layer } from 'effect';
import { isR2ObjectBody } from '../content-cache';
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
		key: string,
		range?: string | null
	) => Effect.Effect<R2ObjectBody, NotFound | StorageError>;
	readonly head: (
		key: string
	) => Effect.Effect<R2Object, NotFound | StorageError>;
	readonly getIfChanged: (
		key: string,
		etag: string
	) => Effect.Effect<
		| { readonly changed: true; readonly object: R2ObjectBody }
		| { readonly changed: false; readonly object: R2Object },
		NotFound | StorageError
	>;
	readonly readTextPrefix: (
		key: string,
		maxBytes: number
	) => Effect.Effect<string, StorageError>;
	readonly delete: (key: string) => Effect.Effect<void, StorageError>;
	readonly deleteMany: (
		keys: ReadonlyArray<string>
	) => Effect.Effect<void, StorageError>;
	readonly deletePrefixes: (
		prefixes: ReadonlyArray<string>
	) => Effect.Effect<void, StorageError>;
	// R2 multipart, used by the staged/resumable upload flow. Each request
	// resumes the upload by (key, uploadId) so parts and completion can span
	// separate HTTP requests.
	readonly createMultipart: (
		key: string,
		contentType: string
	) => Effect.Effect<{ readonly uploadId: string }, StorageError>;
	readonly uploadPart: (
		key: string,
		uploadId: string,
		partNumber: number,
		body: ReadableStream<Uint8Array> | ArrayBuffer,
		size: number
	) => Effect.Effect<
		{ readonly partNumber: number; readonly etag: string },
		StorageError
	>;
	readonly completeMultipart: (
		key: string,
		uploadId: string,
		parts: ReadonlyArray<{ readonly partNumber: number; readonly etag: string }>
	) => Effect.Effect<StoredBlob, StorageError>;
	readonly abortMultipart: (
		key: string,
		uploadId: string
	) => Effect.Effect<void, StorageError>;
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
		get: Effect.fn('Blobs.get')(function* (key, range) {
			const object = yield* Effect.tryPromise({
				try: () =>
					range
						? bucket.get(key, { range: new Headers({ Range: range }) })
						: bucket.get(key),
				catch: (cause) => new StorageError({ operation: 'get blob', cause })
			});
			if (object === null) return yield* new NotFound({ id: key });
			return object;
		}),
		head: Effect.fn('Blobs.head')(function* (key) {
			const object = yield* Effect.tryPromise({
				try: () => bucket.head(key),
				catch: (cause) => new StorageError({ operation: 'head blob', cause })
			});
			if (object === null) return yield* new NotFound({ id: key });
			return object;
		}),
		getIfChanged: Effect.fn('Blobs.getIfChanged')(function* (key, etag) {
			const object = yield* Effect.tryPromise({
				try: async () => {
					try {
						return await bucket.get(key, {
							onlyIf: { etagDoesNotMatch: etag }
						});
					} catch {
						return bucket.get(key);
					}
				},
				catch: (cause) =>
					new StorageError({ operation: 'get blob if changed', cause })
			});
			if (object === null) return yield* new NotFound({ id: key });
			return isR2ObjectBody(object)
				? { changed: true as const, object }
				: { changed: false as const, object };
		}),
		readTextPrefix: Effect.fn('Blobs.readTextPrefix')(
			function* (key, maxBytes) {
				const object = yield* Effect.tryPromise({
					try: () =>
						bucket.get(key, { range: { offset: 0, length: maxBytes } }),
					catch: (cause) =>
						new StorageError({ operation: 'read text prefix', cause })
				});
				if (object === null) {
					return yield* new StorageError({
						operation: 'read text prefix',
						cause: 'Stored object is missing'
					});
				}
				return yield* Effect.tryPromise({
					try: () => object.text(),
					catch: (cause) =>
						new StorageError({ operation: 'decode text prefix', cause })
				});
			}
		),
		delete: Effect.fn('Blobs.delete')(function* (key) {
			yield* Effect.tryPromise({
				try: () => bucket.delete(key),
				catch: (cause) => new StorageError({ operation: 'delete blob', cause })
			});
		}),
		deleteMany: Effect.fn('Blobs.deleteMany')(function* (keys) {
			if (keys.length === 0) return;
			yield* Effect.tryPromise({
				try: async () => {
					for (let index = 0; index < keys.length; index += 500) {
						await bucket.delete(keys.slice(index, index + 500));
					}
				},
				catch: (cause) => new StorageError({ operation: 'delete blobs', cause })
			});
		}),
		deletePrefixes: Effect.fn('Blobs.deletePrefixes')(function* (prefixes) {
			if (prefixes.length === 0) return;
			yield* Effect.tryPromise({
				try: async () => {
					for (const prefix of prefixes) {
						const keys: string[] = [];
						let cursor: string | undefined;
						do {
							const page = await bucket.list({ prefix, cursor, limit: 1_000 });
							keys.push(...page.objects.map((object) => object.key));
							if (!page.truncated) break;
							if (page.cursor === undefined) {
								throw new Error(
									'Truncated R2 listing did not include a cursor'
								);
							}
							cursor = page.cursor;
						} while (cursor !== undefined);
						for (let index = 0; index < keys.length; index += 500) {
							await bucket.delete(keys.slice(index, index + 500));
						}
					}
				},
				catch: (cause) =>
					new StorageError({ operation: 'delete blob prefixes', cause })
			});
		}),
		createMultipart: Effect.fn('Blobs.createMultipart')(function* (
			key,
			contentType
		) {
			const upload = yield* Effect.tryPromise({
				try: () =>
					bucket.createMultipartUpload(key, {
						httpMetadata: { contentType }
					}),
				catch: (cause) =>
					new StorageError({ operation: 'create multipart upload', cause })
			});
			return { uploadId: upload.uploadId };
		}),
		uploadPart: Effect.fn('Blobs.uploadPart')(function* (
			key,
			uploadId,
			partNumber,
			body,
			size
		) {
			const uploaded = yield* Effect.tryPromise({
				try: async () => {
					const upload = bucket.resumeMultipartUpload(key, uploadId);
					// FixedLengthStream pins the exact part length so a truncated
					// or overlong body is rejected at the transform, matching the
					// one-shot upload path.
					if (
						body instanceof ReadableStream &&
						typeof FixedLengthStream !== 'undefined'
					) {
						const { readable, writable } = new FixedLengthStream(size);
						const pumped = body.pipeTo(writable);
						const [part] = await Promise.all([
							upload.uploadPart(partNumber, readable),
							pumped
						]);
						return part;
					}
					const value =
						body instanceof ReadableStream
							? await new Response(body).arrayBuffer()
							: body;
					if (value.byteLength !== size) {
						throw new StorageError({
							operation: 'upload part',
							cause: `Part ${partNumber} was ${value.byteLength} bytes, expected ${size}`
						});
					}
					return upload.uploadPart(partNumber, value);
				},
				catch: (cause) =>
					cause instanceof StorageError
						? cause
						: new StorageError({ operation: 'upload part', cause })
			});
			return { partNumber: uploaded.partNumber, etag: uploaded.etag };
		}),
		completeMultipart: Effect.fn('Blobs.completeMultipart')(function* (
			key,
			uploadId,
			parts
		) {
			const object = yield* Effect.tryPromise({
				try: () => {
					const upload = bucket.resumeMultipartUpload(key, uploadId);
					return upload.complete(
						parts.map((part) => ({
							partNumber: part.partNumber,
							etag: part.etag
						}))
					);
				},
				catch: (cause) =>
					new StorageError({ operation: 'complete multipart upload', cause })
			});
			return { size: object.size, etag: object.httpEtag };
		}),
		abortMultipart: Effect.fn('Blobs.abortMultipart')(function* (
			key,
			uploadId
		) {
			yield* Effect.tryPromise({
				try: () => bucket.resumeMultipartUpload(key, uploadId).abort(),
				catch: (cause) =>
					new StorageError({ operation: 'abort multipart upload', cause })
			});
		})
	});
});

export const BlobsLive = Layer.effect(Blobs, makeBlobs);
