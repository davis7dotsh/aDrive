import { Effect } from 'effect';
import { expect, it } from 'vitest';
import { SNIFF_LENGTH } from './mime-sniff';
import { inspectScanObject } from './scan-inspection';
import { SCAN_HTML_MAX_BYTES } from './scan-policy';
import { scanBlobs } from './test/scan';

it.each([
	['application/octet-stream', SNIFF_LENGTH],
	['text/html', SCAN_HTML_MAX_BYTES]
] as const)(
	'hashes the complete %s body while retaining only a copied prefix',
	async (contentType, retainedBytes) => {
		const bytes = new Uint8Array(2 * 1024 * 1024).fill(65);
		bytes[bytes.length - 1] = 66;
		const blobs = scanBlobs(new Map([['object', bytes]]));
		const result = await Effect.runPromise(
			inspectScanObject(blobs, {
				path: 'object',
				r2Key: 'object',
				contentType,
				sizeBytes: bytes.length
			})
		);
		const hash = Array.from(
			new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)),
			(byte) => byte.toString(16).padStart(2, '0')
		).join('');
		expect(result.sha256).toBe(hash);
		expect(result.bytes?.byteLength).toBe(retainedBytes);
		expect(result.bytes?.buffer.byteLength).toBe(retainedBytes);
		expect(result.bytes?.buffer).not.toBe(bytes.buffer);
	}
);
