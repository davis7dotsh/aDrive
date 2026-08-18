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
		})
	});
});

export const BlobsLive = Layer.effect(Blobs, makeBlobs);
