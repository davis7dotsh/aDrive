import { Schema } from 'effect';
import { describe, expect, it } from 'vitest';
import { FileMutationSchema } from './index';

describe('file mutation schema', () => {
	it('accepts restoring an immutable version as the new current version', () => {
		const decoded = Schema.decodeUnknownOption(FileMutationSchema)({
			action: 'restore-version',
			version: 2
		});

		expect(decoded._tag).toBe('Some');
	});

	it('rejects non-integer restored versions', () => {
		const decoded = Schema.decodeUnknownOption(FileMutationSchema)({
			action: 'restore-version',
			version: 1.5
		});

		expect(decoded._tag).toBe('None');
	});
});
