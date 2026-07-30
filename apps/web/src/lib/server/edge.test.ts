import { Cause } from 'effect';
import { isHttpError } from '@sveltejs/kit';
import { describe, expect, it, vi } from 'vitest';
import {
	InvalidRequest,
	MisdirectedRequest,
	NotFound,
	StorageError,
	Unauthorized
} from './errors';
import { handleCause, isAppError } from './edge';

vi.mock('$app/server', () => ({ getRequestEvent: vi.fn() }));

const captureHttpError = (cause: Cause.Cause<unknown>) => {
	try {
		handleCause(cause);
	} catch (failure) {
		if (isHttpError(failure)) return failure;
		throw failure;
	}
	throw new Error('Expected handleCause to throw');
};

describe('Effect edge failures', () => {
	it('recognizes every concrete application error class', () => {
		expect(
			[
				new InvalidRequest({ status: 400, message: 'invalid' }),
				new MisdirectedRequest({ message: 'wrong origin' }),
				new Unauthorized({ message: 'unauthorized' }),
				new NotFound({ id: 'missing' }),
				new StorageError({
					operation: 'read',
					cause: new Error('unavailable')
				})
			].every(isAppError)
		).toBe(true);
	});

	it('preserves known tagged failures at the HTTP boundary', () => {
		const failure = captureHttpError(
			Cause.fail(
				new InvalidRequest({
					status: 409,
					message: 'Already exists'
				})
			)
		);

		expect(failure.status).toBe(409);
		expect(failure.body.message).toBe('Already exists');
	});

	it('sanitizes unknown typed failures even if they imitate a known tag', () => {
		const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
		const failure = captureHttpError(
			Cause.fail({
				_tag: 'InvalidRequest',
				status: 418,
				message: 'internal secret'
			})
		);

		expect(failure.status).toBe(500);
		expect(failure.body.message).toBe('Internal error');
		expect(failure.body.message).not.toContain('internal secret');
		log.mockRestore();
	});
});
