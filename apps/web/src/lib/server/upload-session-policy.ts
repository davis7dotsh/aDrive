import { InvalidRequest } from './errors';

// R2 multipart rules: every part except the last must be the same size and at
// least 5 MiB, and there can be at most 10,000 parts. We pick a uniform part
// size at session creation so parts can be uploaded (and re-uploaded) in any
// order across separate requests.
export const MIN_PART_BYTES = 5 * 1024 * 1024;
export const DEFAULT_PART_BYTES = 8 * 1024 * 1024;
export const MAX_PARTS = 10_000;
export const UPLOAD_SESSION_TTL_MS = 24 * 60 * 60 * 1000;

export const choosePartSize = (sizeBytes: number) => {
	// A single-part upload (the whole file is the last part) has no minimum.
	if (sizeBytes <= DEFAULT_PART_BYTES) return sizeBytes;
	if (Math.ceil(sizeBytes / DEFAULT_PART_BYTES) <= MAX_PARTS) {
		return DEFAULT_PART_BYTES;
	}
	// Too many parts at the default size: grow the part size to fit the cap.
	return Math.max(MIN_PART_BYTES, Math.ceil(sizeBytes / MAX_PARTS));
};

export const partCountFor = (sizeBytes: number, partSize: number) =>
	Math.max(1, Math.ceil(sizeBytes / partSize));

// The exact expected byte length of a given 1-based part: every part is
// `partSize` except the final one, which holds the remainder.
export const expectedPartSize = (
	partNumber: number,
	sizeBytes: number,
	partSize: number,
	partCount: number
) =>
	partNumber < partCount
		? partSize
		: sizeBytes - (partCount - 1) * partSize;

export const validateSessionSize = (
	sizeBytes: number,
	maxStagedUploadBytes: number
) => {
	if (!Number.isSafeInteger(sizeBytes) || sizeBytes <= 0) {
		throw new InvalidRequest({
			status: 400,
			message: 'A positive file size is required'
		});
	}
	if (sizeBytes > maxStagedUploadBytes) {
		throw new InvalidRequest({
			status: 413,
			message: 'File exceeds the staged upload limit'
		});
	}
};

export const validatePartNumber = (partNumber: number, partCount: number) => {
	if (
		!Number.isSafeInteger(partNumber) ||
		partNumber < 1 ||
		partNumber > partCount
	) {
		throw new InvalidRequest({
			status: 400,
			message: `Part number must be between 1 and ${partCount}`
		});
	}
};

export const validatePartLength = (
	header: string | null,
	expected: number
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
	if (size !== expected) {
		throw new InvalidRequest({
			status: 400,
			message: `Part must be exactly ${expected} bytes`
		});
	}
	return size;
};
