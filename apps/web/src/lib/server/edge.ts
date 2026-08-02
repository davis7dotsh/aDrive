import { getRequestEvent } from '$app/server';
import {
	error,
	isHttpError,
	isRedirect,
	isValidationError,
	type RequestEvent
} from '@sveltejs/kit';
import { Cause, Effect, Exit } from 'effect';
import type { SqlClient } from 'effect/unstable/sql';
import {
	InvalidRequest,
	MisdirectedRequest,
	NotFound,
	StorageError,
	Unauthorized,
	type AppError
} from './errors';
import { requestLayer } from './layer';
import type { AppConfig } from './config';
import type { AuthGuard } from './services/auth-guard';
import type { Auth } from './services/auth';
import type { Blobs } from './services/blobs';
import type { Files } from './services/files';
import type { Search } from './services/search';
import type { Sites } from './services/sites';
import type { Tags } from './services/tags';
import type { Embedder, VectorIndex } from './services/semantic';
import type { Indexing } from './services/indexing';
import type { Lifecycle } from './services/lifecycle';
import type { GrantSecrets } from './services/grant-secrets';

type AppServices =
	| SqlClient.SqlClient
	| AppConfig
	| AuthGuard
	| Auth
	| Blobs
	| Files
	| Search
	| Sites
	| Tags
	| Embedder
	| VectorIndex
	| Indexing
	| Lifecycle
	| GrantSecrets;

export const isAppError = (failure: unknown): failure is AppError =>
	failure instanceof InvalidRequest ||
	failure instanceof MisdirectedRequest ||
	failure instanceof Unauthorized ||
	failure instanceof NotFound ||
	failure instanceof StorageError;

const throwAppError = (
	failure: AppError,
	cause: Cause.Cause<unknown>
): never => {
	switch (failure._tag) {
		case 'InvalidRequest':
			error(failure.status, failure.message);
		case 'MisdirectedRequest':
			error(421, failure.message);
		case 'Unauthorized':
			error(401, failure.message);
		case 'NotFound':
			error(404, 'Not found');
		case 'StorageError':
			console.error(
				JSON.stringify({
					message: 'storage operation failed',
					operation: failure.operation,
					cause: Cause.pretty(cause)
				})
			);
			error(502, 'Storage unavailable');
	}
};

const throwCauseAsHttp = (cause: Cause.Cause<unknown>): never => {
	for (const reason of cause.reasons) {
		if (reason._tag !== 'Die') continue;
		const defect = reason.defect;
		if (
			isHttpError(defect) ||
			isRedirect(defect) ||
			isValidationError(defect)
		) {
			throw defect;
		}
		// An app error thrown synchronously inside a generator arrives here
		// as a defect instead of a typed failure. That's a bug at the call
		// site (it should be yielded), but the client still deserves the
		// intended status, not a blanket 500 — map it, and log it as a bug.
		if (isAppError(defect)) {
			console.error(
				JSON.stringify({
					message: 'app error thrown as defect (should be yielded)',
					tag: defect._tag,
					cause: Cause.pretty(cause)
				})
			);
			return throwAppError(defect, cause);
		}
	}

	if (cause.reasons.some((reason) => reason._tag === 'Die')) {
		console.error(
			JSON.stringify({
				message: 'unhandled Effect defect',
				cause: Cause.pretty(cause)
			})
		);
		error(500, 'Internal error');
	}

	for (const reason of cause.reasons) {
		if (reason._tag !== 'Fail') continue;
		const failure = reason.error;
		if (!isAppError(failure)) continue;
		return throwAppError(failure, cause);
	}

	console.error(
		JSON.stringify({
			message: 'unhandled Effect cause',
			cause: Cause.pretty(cause)
		})
	);
	error(500, 'Internal error');
};

const runWithEvent = async <A, E>(
	event: RequestEvent,
	program: Effect.Effect<A, E, AppServices>
) => {
	const env = event.platform?.env;
	if (!env) error(500, 'Cloudflare bindings unavailable');

	const exit = await Effect.runPromiseExit(
		program.pipe(Effect.provide(requestLayer(env)))
	);
	if (Exit.isSuccess(exit)) return exit.value;
	return throwCauseAsHttp(exit.cause);
};

export const runEdge = <A, E>(program: Effect.Effect<A, E, AppServices>) => {
	const event = getRequestEvent();
	return runWithEvent(event, program);
};

export const runEdgeWithEvent = runWithEvent;
export const handleCause = throwCauseAsHttp;

export const runWorkerProgram = async <A, E>(
	env: Env,
	program: Effect.Effect<A, E, AppServices>
) => {
	const exit = await Effect.runPromiseExit(
		program.pipe(Effect.provide(requestLayer(env)))
	);
	if (Exit.isSuccess(exit)) return exit.value;
	throw new Error(Cause.pretty(exit.cause));
};
