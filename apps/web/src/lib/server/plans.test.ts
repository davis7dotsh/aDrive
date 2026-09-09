import type { Feature, Plan } from 'atmn';
import { describe, expect, it } from 'vitest';
import {
	aiOps,
	free,
	pro,
	publicSharing,
	storageBytes
} from '../../../autumn.config';
import { PLAN_LIMITS, planLimits } from './plans';

const itemFor = (plan: Plan, featureId: string) =>
	(plan.items ?? []).find((item) => item.featureId === featureId);

const consumable = (feature: Feature) =>
	'consumable' in feature ? feature.consumable : undefined;

describe('plan limits', () => {
	it('match the Autumn config for every plan', () => {
		expect(free.id).toBe('free');
		expect(pro.id).toBe('pro');
		expect(itemFor(free, storageBytes.id)?.included).toBe(
			PLAN_LIMITS.free.storedBytes
		);
		expect(itemFor(free, aiOps.id)?.included).toBe(
			PLAN_LIMITS.free.aiOpsPerMonth
		);
		expect(itemFor(pro, storageBytes.id)?.included).toBe(
			PLAN_LIMITS.pro.storedBytes
		);
		expect(itemFor(pro, aiOps.id)?.included).toBe(
			PLAN_LIMITS.pro.aiOpsPerMonth
		);
	});

	it('reset AI operations monthly and keep storage cumulative', () => {
		for (const plan of [free, pro]) {
			expect(itemFor(plan, aiOps.id)?.reset).toEqual({ interval: 'month' });
			expect(itemFor(plan, storageBytes.id)?.reset).toBeUndefined();
		}
		expect(consumable(storageBytes)).toBe(false);
		expect(consumable(aiOps)).toBe(true);
	});

	it('gates public sharing on the paid plan only', () => {
		expect(publicSharing.type).toBe('boolean');
		expect(itemFor(free, publicSharing.id)).toBeUndefined();
		expect(itemFor(pro, publicSharing.id)).toBeDefined();
		expect(free.autoEnable).toBe(true);
		expect(pro.price).toEqual({ amount: 8, interval: 'month' });
	});

	it('treats an unknown plan as free', () => {
		expect(planLimits('enterprise')).toEqual(PLAN_LIMITS.free);
		expect(planLimits('pro')).toEqual(PLAN_LIMITS.pro);
	});
});
