import { describe, expect, it } from 'vitest';
import { decodeBillingWebhook } from './billing-webhook';

const updated = (data: Record<string, unknown> = {}) => ({
	type: 'billing.updated',
	data: { customer_id: 'org_1', ...data }
});

describe('Autumn webhook decoding', () => {
	it.each([
		{ name: 'empty', changes: [] },
		{
			name: 'expired',
			changes: [
				{
					action: 'expired',
					subscription: { plan_id: 'pro', status: 'expired' }
				}
			]
		},
		{
			name: 'scheduled',
			changes: [
				{
					action: 'scheduled',
					subscription: { plan_id: 'free', status: 'scheduled' }
				}
			]
		},
		{
			name: 'unrelated',
			changes: [
				{
					action: 'updated',
					subscription: { plan_id: 'unrelated', status: 'active' }
				}
			]
		}
	])('treats $name plan deltas as reconciliation signals', ({ changes }) => {
		expect(decodeBillingWebhook(updated({ plan_changes: changes }))).toEqual({
			kind: 'reconcile',
			orgId: 'org_1'
		});
	});

	it('also reconciles a customer-level update without a plan delta', () => {
		expect(decodeBillingWebhook(updated())).toEqual({
			kind: 'reconcile',
			orgId: 'org_1'
		});
	});

	it('ignores other event types even when they contain plan_changes', () => {
		expect(
			decodeBillingWebhook({
				type: 'balances.limit_reached',
				data: { customer_id: 'org_1', plan_changes: [] }
			})
		).toEqual({ kind: 'ignored', type: 'balances.limit_reached' });
	});

	it('ignores entity-scoped and malformed events', () => {
		expect(decodeBillingWebhook(updated({ entity_id: 'team_1' }))).toEqual({
			kind: 'ignored',
			type: 'billing.updated'
		});
		for (const customer_id of ['', null, undefined, 123]) {
			expect(decodeBillingWebhook(updated({ customer_id }))).toEqual({
				kind: 'ignored',
				type: 'billing.updated'
			});
		}
		expect(decodeBillingWebhook('nope')).toEqual({ kind: 'ignored', type: '' });
	});
});
