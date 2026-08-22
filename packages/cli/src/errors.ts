import { Data } from 'effect';

// message  — the human-readable hint shown on the top line
// detail   — dimmed context below it (e.g. "POST <url> → 404")
// status   — HTTP status when the failure came from a response
export class CliFailure extends Data.TaggedError('CliFailure')<{
	readonly message: string;
	readonly detail?: string;
	readonly status?: number;
	readonly cause?: unknown;
}> {}
