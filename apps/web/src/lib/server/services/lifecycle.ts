import { Context, Effect, Layer } from 'effect';
import { Auth } from './auth';
import { Files } from './files';
import { Indexing } from './indexing';
import { Sites } from './sites';

export interface LifecycleSummary {
	readonly authentication: number;
	readonly sites: number;
	readonly indexing: number;
	readonly files: number;
	readonly vectors: number;
}

export interface LifecycleShape {
	readonly run: Effect.Effect<LifecycleSummary>;
}

export class Lifecycle extends Context.Service<Lifecycle, LifecycleShape>()(
	'app/Lifecycle'
) {}

export interface LifecycleTasks {
	readonly authentication: Effect.Effect<number, unknown>;
	readonly sites: Effect.Effect<number, unknown>;
	readonly indexing: Effect.Effect<number, unknown>;
	readonly files: Effect.Effect<number, unknown>;
	readonly vectors: Effect.Effect<number, unknown>;
}

const recover = <A>(
	name: string,
	effect: Effect.Effect<A, unknown>,
	fallback: A
) =>
	effect.pipe(
		Effect.catchCause((cause) =>
			Effect.sync(() => {
				console.error(
					JSON.stringify({
						message: 'scheduled lifecycle task failed',
						task: name,
						cause: String(cause)
					})
				);
				return fallback;
			})
		)
	);

export const runLifecycleTasks = (tasks: LifecycleTasks) =>
	Effect.gen(function* () {
		const authentication = yield* recover(
			'authentication',
			tasks.authentication,
			0
		);
		const sites = yield* recover('sites', tasks.sites, 0);
		const indexing = yield* recover('indexing', tasks.indexing, 0);
		const files = yield* recover('files', tasks.files, 0);
		const vectors = yield* recover('vectors', tasks.vectors, 0);
		return { authentication, sites, indexing, files, vectors };
	});

const makeLifecycle = Effect.gen(function* () {
	const auth = yield* Auth;
	const files = yield* Files;
	const indexing = yield* Indexing;
	const sites = yield* Sites;

	const run = runLifecycleTasks({
		authentication: auth.enforcePasscodeRotation.pipe(
			Effect.flatMap((rotation) =>
				auth
					.sweepExpired(100)
					.pipe(Effect.map((swept) => rotation.revoked + swept))
			)
		),
		sites: sites.sweepLifecycle(10),
		indexing: indexing.runDue(5),
		files: files.sweepPurges(5),
		vectors: indexing.retryVectorDeletes(100)
	}).pipe(Effect.withSpan('Lifecycle.run'));

	return Lifecycle.of({ run });
});

export const LifecycleLive = Layer.effect(Lifecycle, makeLifecycle);
