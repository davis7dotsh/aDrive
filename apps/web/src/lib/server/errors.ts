import { Data, Effect } from 'effect';

export class InvalidRequest extends Data.TaggedError('InvalidRequest')<{
	readonly status: 400 | 403 | 404 | 409 | 411 | 413 | 416;
	readonly message: string;
}> {}

export class MisdirectedRequest extends Data.TaggedError('MisdirectedRequest')<{
	readonly message: string;
}> {}

export class Unauthorized extends Data.TaggedError('Unauthorized')<{
	readonly message: string;
}> {}

export class NotFound extends Data.TaggedError('NotFound')<{
	readonly id: string;
}> {}

export class StorageError extends Data.TaggedError('StorageError')<{
	readonly operation: string;
	readonly cause: unknown;
}> {}

export type AppError =
	InvalidRequest | MisdirectedRequest | Unauthorized | NotFound | StorageError;

// Lift a synchronous validator that throws InvalidRequest into the Effect
// error channel. Calling such a validator bare inside a generator turns a
// throw into a defect (HTTP 500); this keeps it a typed 4xx failure.
export const validate = <A>(fn: () => A) =>
	Effect.try({
		try: fn,
		catch: (cause) =>
			cause instanceof InvalidRequest
				? cause
				: new InvalidRequest({ status: 400, message: 'The request is invalid' })
	});
