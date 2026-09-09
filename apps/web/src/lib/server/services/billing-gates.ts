import { Context, Effect, Layer } from 'effect';
import { AutumnClient } from './autumn';

// Plan gates answered by Autumn. Every answer fails open (an unreachable
// or unconfigured Autumn allows), so a gate here is never the only stop:
// storage has the local reservation, and public sharing is combined with
// the org's trust in trust-policy (stack E), which consults canShare.
export interface BillingGatesShape {
	// Whether the org's plan carries the public_sharing feature.
	readonly canShare: (orgId: string) => Effect.Effect<boolean>;
	// Whether the org may embed `chunks` more chunks this cycle.
	readonly canEmbed: (orgId: string, chunks: number) => Effect.Effect<boolean>;
}

export class BillingGates extends Context.Service<
	BillingGates,
	BillingGatesShape
>()('app/BillingGates') {}

export const BillingGatesLive = Layer.effect(
	BillingGates,
	Effect.map(AutumnClient, (autumn) =>
		BillingGates.of({
			canShare: (orgId) =>
				autumn
					.check({ customerId: orgId, featureId: 'public_sharing' })
					.pipe(Effect.map((result) => result.allowed)),
			canEmbed: (orgId, chunks) =>
				autumn
					.check({
						customerId: orgId,
						featureId: 'ai_ops',
						requiredBalance: Math.max(1, chunks)
					})
					.pipe(Effect.map((result) => result.allowed))
		})
	)
);
