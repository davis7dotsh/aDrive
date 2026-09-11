import { Effect } from 'effect';
import { StorageError } from './errors';
import { SNIFF_LENGTH } from './mime-sniff';
import { SCAN_HASH_MAX_BYTES, SCAN_HTML_MAX_BYTES } from './scan-policy';
import type { Blobs } from './services/blobs';

export interface ScanObject {
	readonly path: string;
	readonly r2Key: string;
	readonly contentType: string;
	readonly sizeBytes: number;
}

export const isHtml = (contentType: string) =>
	contentType.split(';', 1)[0]?.trim().toLowerCase() === 'text/html';

const toHex = (digest: ArrayBuffer) =>
	Array.from(new Uint8Array(digest), (byte) =>
		byte.toString(16).padStart(2, '0')
	).join('');

// The whole object is transient input to the hash, never a retained scan
// result. Callers inspect sequentially to bound full-body allocations.
export const inspectScanObject = Effect.fn('Scanner.inspect')(function* (
	blobs: Blobs['Service'],
	object: ScanObject
) {
	const whole = object.sizeBytes <= SCAN_HASH_MAX_BYTES;
	const loaded = yield* blobs
		.get(object.r2Key, whole ? null : `bytes=0-${SNIFF_LENGTH - 1}`)
		.pipe(Effect.catchTag('NotFound', () => Effect.succeed(null)));
	if (loaded === null) {
		return { object, missing: true as const, sha256: null, bytes: null };
	}
	const bytes = new Uint8Array(
		yield* Effect.tryPromise({
			try: () => loaded.arrayBuffer(),
			catch: (cause) =>
				new StorageError({ operation: 'read object to scan', cause })
		})
	);
	const sha256 = whole
		? toHex(yield* Effect.promise(() => crypto.subtle.digest('SHA-256', bytes)))
		: null;
	// A subarray alone would keep the full backing buffer alive.
	const retained = bytes.slice(
		0,
		isHtml(object.contentType) ? SCAN_HTML_MAX_BYTES : SNIFF_LENGTH
	);
	return { object, missing: false as const, sha256, bytes: retained };
});
