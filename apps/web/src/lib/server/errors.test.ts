import { Effect, Exit } from 'effect';
import { describe, expect, it } from 'vitest';
import { InvalidRequest, validate } from './errors';

describe('validate', () => {
	it('passes a successful validator through', async () => {
		const result = await Effect.runPromise(validate(() => 42));
		expect(result).toBe(42);
	});

	it('lifts a thrown InvalidRequest into a typed failure, not a defect', async () => {
		const exit = await Effect.runPromiseExit(
			validate(() => {
				throw new InvalidRequest({ status: 400, message: 'bad color' });
			})
		);
		expect(Exit.isFailure(exit)).toBe(true);
		if (Exit.isFailure(exit)) {
			const failure = exit.cause.reasons.find((r) => r._tag === 'Fail');
			expect(failure?._tag).toBe('Fail');
			const error = failure && 'error' in failure ? failure.error : undefined;
			expect(error).toBeInstanceOf(InvalidRequest);
			expect((error as InvalidRequest).message).toBe('bad color');
			// No Die reason: the throw must not escape as a 500 defect.
			expect(exit.cause.reasons.some((r) => r._tag === 'Die')).toBe(false);
		}
	});

	it('wraps a non-InvalidRequest throw as a generic 400', async () => {
		const exit = await Effect.runPromiseExit(
			validate(() => {
				throw new Error('unexpected');
			})
		);
		expect(Exit.isFailure(exit)).toBe(true);
		if (Exit.isFailure(exit)) {
			const failure = exit.cause.reasons.find((r) => r._tag === 'Fail');
			const error = failure && 'error' in failure ? failure.error : undefined;
			expect(error).toBeInstanceOf(InvalidRequest);
			expect((error as InvalidRequest).status).toBe(400);
		}
	});
});
