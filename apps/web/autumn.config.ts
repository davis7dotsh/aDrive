import { feature, item, plan } from 'atmn';

// Plans and features as Autumn config. `bun run billing:push` deploys it;
// src/lib/server/plans.ts mirrors the limits for the local hard stops and
// plans.test.ts keeps the two in step. The customer id is the org id.

const GIB = 1024 ** 3;

export const storageBytes = feature({
	id: 'storage_bytes',
	name: 'Storage',
	type: 'metered',
	consumable: false
});

export const aiOps = feature({
	id: 'ai_ops',
	name: 'AI operations',
	type: 'metered',
	consumable: true
});

export const publicSharing = feature({
	id: 'public_sharing',
	name: 'Public sharing',
	type: 'boolean'
});

export const free = plan({
	id: 'free',
	name: 'Free',
	autoEnable: true,
	items: [
		item({ featureId: storageBytes.id, included: 2 * GIB }),
		item({
			featureId: aiOps.id,
			included: 500,
			reset: { interval: 'month' }
		})
	]
});

export const pro = plan({
	id: 'pro',
	name: 'Pro',
	price: { amount: 8, interval: 'month' },
	items: [
		item({ featureId: storageBytes.id, included: 100 * GIB }),
		item({
			featureId: aiOps.id,
			included: 10_000,
			reset: { interval: 'month' }
		}),
		item({ featureId: publicSharing.id })
	]
});
