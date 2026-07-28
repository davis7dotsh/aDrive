import { Data } from 'effect';

export class InvalidRequest extends Data.TaggedError('InvalidRequest')<{
	readonly status: 400 | 411 | 413;
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
