import { Context, Effect, Layer } from 'effect';
import { Auth } from './auth';
import { Files } from './files';
import { Indexing } from './indexing';
import { Sites } from './sites';
import { Uploads } from './uploads';

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
	const uploads = yield* Uploads;

	const run = runLifecycleTasks({
		// Rotation and sweep are independent: a failed rotation check must
		// not stop expired-credential cleanup, and vice versa.
		authentication: Effect.zip(
			auth.enforcePasscodeRotation.pipe(
				Effect.map((rotation) => rotation.revoked),
				Effect.catchCause((cause) =>
					Effect.sync(() => {
						console.error(
							JSON.stringify({
								message: 'passcode rotation enforcement failed',
								cause: String(cause)
							})
						);
						return 0;
					})
				)
			),
			auth.sweepExpired(100)
		).pipe(Effect.map(([revoked, swept]) => revoked + swept)),
		sites: sites.sweepLifecycle(10),
		indexing: indexing.runDue(5),
		// Fold expired staged-upload cleanup into the file task so an
		// abandoned multipart upload's R2 parts and quota reservation are
		// released without changing the summary shape. The two counts are
		// independent: an upload sweep failure cannot lose the purge count.
		files: Effect.zip(
			files.sweepPurges(5),
			uploads
				.sweep(10)
				.pipe(Effect.catchCause(() => Effect.succeed(0)))
		).pipe(Effect.map(([purged, swept]) => purged + swept)),
		vectors: indexing.retryVectorDeletes(100)
	}).pipe(Effect.withSpan('Lifecycle.run'));

	return Lifecycle.of({ run });
});

export const LifecycleLive = Layer.effect(Lifecycle, makeLifecycle);
