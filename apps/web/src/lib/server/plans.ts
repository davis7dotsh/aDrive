// Per-plan limits, mirrored from autumn.config.ts (plans.test.ts keeps them
// in step). The local org_usage counters are the hard stop; Autumn holds
// the same numbers so its balances and the billing page agree.
const GIB = 1024 ** 3;

export const PLAN_LIMITS = {
	free: { storedBytes: 2 * GIB, aiOpsPerMonth: 500 },
	pro: { storedBytes: 100 * GIB, aiOpsPerMonth: 10_000 }
} as const;

export type Plan = keyof typeof PLAN_LIMITS;

export const PRO_PLAN_ID: Plan = 'pro';

export const isPlan = (value: string): value is Plan =>
	Object.hasOwn(PLAN_LIMITS, value);

// Unknown plans fall back to free so a typo in the column can only make
// an org smaller, never unlimited.
export const planLimits = (plan: string) =>
	isPlan(plan) ? PLAN_LIMITS[plan] : PLAN_LIMITS.free;
