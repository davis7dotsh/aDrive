import { Context, Effect, Layer } from 'effect';
import { AutumnClient } from './autumn';

// Autumn's advisory gate fails open during an outage. Indexing reserves
// local monthly quota before embedding, which remains the hard stop.
export interface BillingGatesShape {
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
