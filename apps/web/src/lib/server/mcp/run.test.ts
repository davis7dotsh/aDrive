import { Cause } from 'effect';
import { describe, expect, it } from 'vitest';
import {
	InvalidRequest,
	NotFound,
	StorageError,
	Unauthorized
} from '../errors';
import { failureFromAppError, failureFromCause } from './run';

describe('MCP error mapping', () => {
	it('maps tagged app errors to HTTP-shaped failures', () => {
		expect(
			failureFromAppError(
				new InvalidRequest({ status: 413, message: 'too large' })
			)
		).toEqual({ ok: false, message: 'too large', status: 413 });
		expect(failureFromAppError(new Unauthorized({ message: 'nope' }))).toEqual({
			ok: false,
			message: 'nope',
			status: 401
		});
		expect(failureFromAppError(new NotFound({ id: 'missing' }))).toEqual({
			ok: false,
			message: 'Not found',
			status: 404
		});
		expect(
			failureFromAppError(
				new StorageError({ operation: 'put blob', cause: new Error('r2') })
			)
		).toEqual({ ok: false, message: 'Storage unavailable', status: 502 });
	});

	it('does not leak storage causes from an Effect fail', () => {
		const failure = failureFromCause(
			Cause.fail(
				new StorageError({
					operation: 'put blob',
					cause: new Error('bucket secret')
				})
			)
		);
		expect(failure.message).toBe('Storage unavailable');
		expect(failure.message).not.toContain('secret');
	});

	it('maps unknown defects to a generic 500', () => {
		const failure = failureFromCause(Cause.die(new Error('boom')));
		expect(failure).toEqual({
			ok: false,
			message: 'Internal error',
			status: 500
		});
	});
});
