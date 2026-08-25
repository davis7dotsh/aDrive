import { describe, expect, it } from 'vitest';
import {
	choosePartSize,
	DEFAULT_PART_BYTES,
	expectedPartSize,
	MAX_PARTS,
	MIN_PART_BYTES,
	partCountFor
} from './upload-session-policy';

describe('staged upload part math', () => {
	it('uses a single part when the file fits the default part size', () => {
		expect(choosePartSize(10)).toBe(10);
		expect(partCountFor(10, choosePartSize(10))).toBe(1);
	});

	it('keeps the default part size for moderately large files', () => {
		const size = DEFAULT_PART_BYTES * 3 + 123;
		expect(choosePartSize(size)).toBe(DEFAULT_PART_BYTES);
		expect(partCountFor(size, DEFAULT_PART_BYTES)).toBe(4);
	});

	it('grows the part size so the part count never exceeds the cap', () => {
		const size = DEFAULT_PART_BYTES * (MAX_PARTS + 5);
		const partSize = choosePartSize(size);
		expect(partSize).toBeGreaterThanOrEqual(MIN_PART_BYTES);
		expect(partCountFor(size, partSize)).toBeLessThanOrEqual(MAX_PARTS);
	});

	it('gives the final part the remainder bytes', () => {
		const size = DEFAULT_PART_BYTES + 1000;
		const partSize = choosePartSize(size);
		const count = partCountFor(size, partSize);
		expect(count).toBe(2);
		expect(expectedPartSize(1, size, partSize, count)).toBe(partSize);
		expect(expectedPartSize(2, size, partSize, count)).toBe(1000);
	});
});
