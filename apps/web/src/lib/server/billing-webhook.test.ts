import { describe, expect, it } from 'vitest';
import { decodeBillingWebhook } from './billing-webhook';

const updated = (
	changes: ReadonlyArray<Record<string, unknown>>,
	data: Record<string, unknown> = {}
) => ({
	type: 'billing.updated',
	data: {
		object: 'billing.updated',
		customer_id: 'org_1',
		plan_changes: changes,
		...data
	}
});

const subscription = (plan_id: string, status = 'active') => ({
	plan_id,
	status
});

describe('Autumn webhook decoding', () => {
	it('moves to pro when a pro plan activates and free expires', () => {
		expect(
			decodeBillingWebhook(
				updated([
					{ action: 'activated', subscription: subscription('pro') },
					{ action: 'expired', subscription: subscription('free', 'expired') }
				])
			)
		).toEqual({ kind: 'plan', orgId: 'org_1', plan: 'pro' });
	});

	it('moves back to free when pro expires', () => {
		expect(
			decodeBillingWebhook(
				updated([
					{ action: 'expired', subscription: subscription('pro', 'expired') },
					{ action: 'activated', subscription: subscription('free') }
				])
			)
		).toEqual({ kind: 'plan', orgId: 'org_1', plan: 'free' });
		expect(
			decodeBillingWebhook(
				updated([
					{ action: 'expired', subscription: subscription('pro', 'expired') }
				])
			)
		).toEqual({ kind: 'plan', orgId: 'org_1', plan: 'free' });
	});

	it('keeps pro while a cancellation is only scheduled', () => {
		expect(
			decodeBillingWebhook(
				updated([
					{
						action: 'updated',
						subscription: { ...subscription('pro'), canceled_at: 1 },
						previous_attributes: { canceled_at: null }
					}
				])
			)
		).toEqual({ kind: 'plan', orgId: 'org_1', plan: 'pro' });
	});

	it('does not count a scheduled plan or an unknown plan id', () => {
		expect(
			decodeBillingWebhook(
				updated([
					{
						action: 'scheduled',
						subscription: subscription('pro', 'scheduled')
					},
					{ action: 'activated', subscription: subscription('enterprise') }
				])
			)
		).toEqual({ kind: 'plan', orgId: 'org_1', plan: 'free' });
	});

	it('ignores other events, entity-scoped changes, and malformed payloads', () => {
		expect(
			decodeBillingWebhook({
				type: 'balances.limit_reached',
				data: { customer_id: 'org_1', feature_id: 'ai_ops' }
			})
		).toEqual({ kind: 'ignored', type: 'balances.limit_reached' });
		expect(
			decodeBillingWebhook(
				updated([{ action: 'activated', subscription: subscription('pro') }], {
					entity_id: 'team_1'
				})
			)
		).toEqual({ kind: 'ignored', type: 'billing.updated' });
		expect(decodeBillingWebhook('nope')).toEqual({ kind: 'ignored', type: '' });
		expect(
			decodeBillingWebhook({
				type: 'billing.updated',
				data: { plan_changes: [] }
			})
		).toEqual({ kind: 'ignored', type: 'billing.updated' });
	});
});
