import { Cause, Effect, Exit } from 'effect';
import { isAppError, runWorkerProgram, type AppServices } from '../edge';
import type { AppError } from '../errors';
import { requestLayer } from '../layer';
import { Indexing } from '../services/indexing';

export type McpRunSuccess<A> = { readonly ok: true; readonly value: A };
export type McpRunFailure = {
	readonly ok: false;
	readonly message: string;
	readonly status: number;
};
export type McpRunResult<A> = McpRunSuccess<A> | McpRunFailure;

export const failureFromAppError = (failure: AppError): McpRunFailure => {
	switch (failure._tag) {
		case 'InvalidRequest':
			return { ok: false, message: failure.message, status: failure.status };
		case 'MisdirectedRequest':
			return { ok: false, message: failure.message, status: 421 };
		case 'Unauthorized':
			return { ok: false, message: failure.message, status: 401 };
		case 'NotFound':
			return { ok: false, message: 'Not found', status: 404 };
		case 'StorageError':
			return { ok: false, message: 'Storage unavailable', status: 502 };
	}
};

export const failureFromCause = (
	cause: Cause.Cause<unknown>
): McpRunFailure => {
	const dieDefects = cause.reasons
		.filter((reason) => reason._tag === 'Die')
		.map((reason) => reason.defect);

	if (dieDefects.some((defect) => !isAppError(defect))) {
		return { ok: false, message: 'Internal error', status: 500 };
	}

	const appDefect = dieDefects.find(isAppError);
	if (appDefect) return failureFromAppError(appDefect);

	for (const reason of cause.reasons) {
		if (reason._tag !== 'Fail') continue;
		if (!isAppError(reason.error)) continue;
		return failureFromAppError(reason.error);
	}

	return { ok: false, message: 'Internal error', status: 500 };
};

export const runMcp = async <A, E>(
	env: Env,
	program: Effect.Effect<A, E, AppServices>
): Promise<McpRunResult<A>> => {
	const exit = await Effect.runPromiseExit(
		program.pipe(Effect.provide(requestLayer(env)))
	);
	if (Exit.isSuccess(exit)) return { ok: true, value: exit.value };
	return failureFromCause(exit.cause);
};

export const scheduleIndex = (
	env: Env,
	ctx: ExecutionContext,
	fileId: string
) => {
	ctx.waitUntil(
		runWorkerProgram(
			env,
			Effect.gen(function* () {
				const indexing = yield* Indexing;
				yield* indexing.process(fileId);
			})
		)
	);
};
