import { getRequestEvent } from '$app/server';
import {
	error,
	isHttpError,
	isRedirect,
	isValidationError,
	type RequestEvent
} from '@sveltejs/kit';
import { Cause, Effect, Exit } from 'effect';
import {
	InvalidRequest,
	MisdirectedRequest,
	NotFound,
	StorageError,
	Unauthorized,
	type AppError
} from './errors';
import type { ProgramIdentity } from './identity';
import { requestLayer } from './layer';
import { PgSql } from './pg';
import type { AppConfig } from './config';
import type { AuthGuard } from './services/auth-guard';
import type { Auth } from './services/auth';
import type { Blobs } from './services/blobs';
import type { CurrentOrg, CurrentUser } from './services/current-org';
import type { Files } from './services/files';
import type { Search } from './services/search';
import type { Sites } from './services/sites';
import type { Tags } from './services/tags';
import type { Embedder, VectorIndex } from './services/semantic';
import type { Indexing } from './services/indexing';
import type { Lifecycle } from './services/lifecycle';
import type { GrantSecrets } from './services/grant-secrets';
import type { JobQueue } from './services/jobs';
import type { WorkOSClient } from './services/workos';

export type AppServices =
	| PgSql
	| AppConfig
	| AuthGuard
	| Auth
	| Blobs
	| CurrentOrg
	| CurrentUser
	| Files
	| Search
	| Sites
	| Tags
	| Embedder
	| VectorIndex
	| Indexing
	| Lifecycle
	| GrantSecrets
	| JobQueue
	| WorkOSClient;

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
	const dieDefects = cause.reasons
		.filter((reason) => reason._tag === 'Die')
		.map((reason) => reason.defect);

	// SvelteKit's own control-flow objects always take precedence.
	for (const defect of dieDefects) {
		if (
			isHttpError(defect) ||
			isRedirect(defect) ||
			isValidationError(defect)
		) {
			throw defect;
		}
	}

	// A genuine unexpected defect (a real bug) must win a 500 over an
	// app-error that merely escaped as a defect — otherwise a concurrent
	// bug could be masked by another fiber's misplaced 4xx.
	if (dieDefects.some((defect) => !isAppError(defect))) {
		console.error(
			JSON.stringify({
				message: 'unhandled Effect defect',
				cause: Cause.pretty(cause)
			})
		);
		error(500, 'Internal error');
	}

	// Every die is an app error thrown synchronously inside a generator
	// (a call-site bug — it should be yielded). Map the first to its
	// intended status so the client isn't handed a blanket 500, and log it.
	const appDefect = dieDefects.find(isAppError);
	if (appDefect) {
		console.error(
			JSON.stringify({
				message: 'app error thrown as defect (should be yielded)',
				tag: appDefect._tag,
				cause: Cause.pretty(cause)
			})
		);
		return throwAppError(appDefect, cause);
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

// The tenant comes from the request's resolved credential. A request
// without one still gets a layer (sign-in, device polling, content routes
// all run before or without a tenant); reading the org there is a bug and
// surfaces as a defect, never as another org's rows.
const runWithEvent = async <A, E>(
	event: RequestEvent,
	program: Effect.Effect<A, E, AppServices>
) => {
	const env = event.platform?.env;
	if (!env) error(500, 'Cloudflare bindings unavailable');

	const exit = await Effect.runPromiseExit(
		program.pipe(Effect.provide(requestLayer(env, event.locals.auth)))
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

// Background and scheduled work runs outside a request, so the caller
// names the tenant. Work that touches no tenant rows (queue plumbing,
// credential lookups, tests of platform tables) passes null.
export const runWorkerProgram = async <A, E>(
	env: Env,
	program: Effect.Effect<A, E, AppServices>,
	identity: ProgramIdentity | null = null
) => {
	const exit = await Effect.runPromiseExit(
		program.pipe(Effect.provide(requestLayer(env, identity)))
	);
	if (Exit.isSuccess(exit)) return exit.value;
	throw new Error(Cause.pretty(exit.cause));
};

// Reconciliation sweeps visit a random handful of live orgs per tick so a
// busy tenant cannot starve the rest. The program runs once per org with
// that org as CurrentOrg; one org's failure is logged and the loop moves
// on. Returns each org's result.
export const runAcrossOrgs = async <A, E>(
	env: Env,
	program: Effect.Effect<A, E, AppServices>,
	options: { readonly limit?: number } = {}
) => {
	const limit = Math.max(1, Math.min(options.limit ?? 20, 100));
	const orgIds = await runWorkerProgram(
		env,
		Effect.flatMap(
			PgSql,
			(sql) => sql<{ id: string }>`
				SELECT id FROM orgs
				WHERE trust <> 'suspended'
				ORDER BY random()
				LIMIT ${limit}`
		).pipe(Effect.map((rows) => rows.map((row) => row.id)))
	);
	const results: Array<{ readonly orgId: string; readonly value: A }> = [];
	for (const orgId of orgIds) {
		try {
			const value = await runWorkerProgram(env, program, {
				orgId,
				userId: 'system'
			});
			results.push({ orgId, value });
		} catch (cause) {
			console.error(
				JSON.stringify({
					message: 'per-org program failed',
					orgId,
					cause: String(cause)
				})
			);
		}
	}
	return results;
};
