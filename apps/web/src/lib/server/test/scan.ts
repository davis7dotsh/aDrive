import { Effect } from 'effect';
import { NotFound } from '../errors';
import type { Blobs } from '../services/blobs';

// Complete typed R2 body for scanner tests; buffers are observable so
// memory retention can be checked without measuring a process heap.
export const scanBlob = (
	key: string,
	bytes: Uint8Array<ArrayBuffer>
): R2ObjectBody => ({
	key,
	version: 'test',
	size: bytes.byteLength,
	etag: 'test',
	httpEtag: '"test"',
	uploaded: new Date(),
	storageClass: 'Standard',
	checksums: { toJSON: () => ({}) },
	writeHttpMetadata: () => {},
	body: new Response(bytes).body!,
	bodyUsed: false,
	arrayBuffer: async () => bytes.buffer,
	bytes: async () => bytes,
	text: async () => new TextDecoder().decode(bytes),
	json: async () => {
		throw new Error('Scanner does not parse blob JSON');
	},
	blob: async () => new Blob([bytes])
});

export const scanBlobs = (objects: Map<string, Uint8Array<ArrayBuffer>>) => {
	const unexpected = () =>
		Effect.die('Unexpected blob mutation in scanner test');
	return {
		get: (key: string) => {
			const bytes = objects.get(key);
			return bytes
				? Effect.succeed(scanBlob(key, bytes))
				: Effect.fail(new NotFound({ id: key }));
		},
		readTextPrefix: (key: string, limit: number) =>
			Effect.succeed(
				new TextDecoder().decode(objects.get(key)?.subarray(0, limit))
			),
		put: unexpected,
		head: unexpected,
		getIfChanged: unexpected,
		delete: unexpected,
		deleteMany: unexpected,
		deletePrefixes: unexpected
	} satisfies Blobs['Service'];
};
