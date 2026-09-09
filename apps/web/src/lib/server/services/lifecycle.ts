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
}

// Per-org caps. Small on purpose: the tick visits a random handful of
// orgs, so a busy tenant only ever gets its share.
export const ORG_SWEEP_LIMIT = 2;

export interface LifecycleShape {
	// Work that is not tenant-scoped (device codes); runs once per tick.
	readonly global: Effect.Effect<number>;
	// One org's share of purges, indexing, and site cleanup; runAcrossOrgs
	// in edge.ts runs it once per randomly chosen live org.
	readonly org: Effect.Effect<LifecycleSummary>;
}

export class Lifecycle extends Context.Service<Lifecycle, LifecycleShape>()(
	'app/Lifecycle'
) {}

export interface LifecycleTasks {
	readonly authentication: Effect.Effect<number, unknown>;
	readonly sites: Effect.Effect<number, unknown>;
	readonly indexing: Effect.Effect<number, unknown>;
	readonly files: Effect.Effect<number, unknown>;
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
		return { authentication, sites, indexing, files };
	});

export const summarize = (
	authentication: number,
	perOrg: ReadonlyArray<LifecycleSummary>
): LifecycleSummary =>
	perOrg.reduce(
		(total, summary) => ({
			authentication: total.authentication,
			sites: total.sites + summary.sites,
			indexing: total.indexing + summary.indexing,
			files: total.files + summary.files
		}),
		{ authentication, sites: 0, indexing: 0, files: 0 }
	);

const makeLifecycle = Effect.gen(function* () {
	const auth = yield* Auth;
	const files = yield* Files;
	const indexing = yield* Indexing;
	const sites = yield* Sites;

	const global = recover('authentication', auth.sweepExpired(100), 0).pipe(
		Effect.withSpan('Lifecycle.global')
	);

	const org = runLifecycleTasks({
		authentication: Effect.succeed(0),
		sites: sites.sweepLifecycle(ORG_SWEEP_LIMIT),
		indexing: indexing.runDue(ORG_SWEEP_LIMIT),
		files: files.sweepPurges(ORG_SWEEP_LIMIT)
	}).pipe(Effect.withSpan('Lifecycle.org'));

	return Lifecycle.of({ global, org });
});

export const LifecycleLive = Layer.effect(Lifecycle, makeLifecycle);
