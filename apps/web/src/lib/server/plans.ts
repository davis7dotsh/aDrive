// Per-plan limits. Stack F replaces the lookup with an Autumn check; until
// then the org's plan column picks a row here.
const GIB = 1024 ** 3;

export const PLAN_LIMITS = {
	free: { storedBytes: 2 * GIB },
	pro: { storedBytes: 100 * GIB }
} as const;

export type Plan = keyof typeof PLAN_LIMITS;

const isPlan = (value: string): value is Plan => value in PLAN_LIMITS;

// Unknown plans fall back to free so a typo in the column can only make
// an org smaller, never unlimited.
export const planLimits = (plan: string) =>
	isPlan(plan) ? PLAN_LIMITS[plan] : PLAN_LIMITS.free;
