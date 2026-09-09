// Org trust levels (orgs.trust). An org starts `new` at sign-up, becomes
// `verified` once a member signs in with a verified email, and
// `established` after 14 days on a paid plan or an admin bump. `suspended`
// is the kill switch: the content host answers 404 and credentials stop
// resolving.

export const TRUST_LEVELS = [
	'new',
	'verified',
	'established',
	'suspended'
] as const;

export type TrustLevel = (typeof TRUST_LEVELS)[number];

export const isTrustLevel = (value: string): value is TrustLevel =>
	(TRUST_LEVELS as ReadonlyArray<string>).includes(value);

// An unknown value in the column can only make an org less trusted.
export const parseTrust = (value: string): TrustLevel =>
	isTrustLevel(value) ? value : 'new';

// Whether the org may make anything public: files, and sites (which are
// always public). The free plan shares publicly too once verified; every
// publish by a verified org is scanned before it goes live.
export const canPublish = (trust: TrustLevel) =>
	trust === 'verified' || trust === 'established';

// Verified orgs publish behind the scanner; established ones publish now
// and are scanned after.
export const scanBeforePublish = (trust: TrustLevel) => trust === 'verified';

export const publishLimitPerHour = (trust: TrustLevel) => {
	switch (trust) {
		case 'verified':
			return 30;
		case 'established':
			return 300;
		case 'new':
		case 'suspended':
			return 0;
	}
};

export const PUBLISH_BLOCKED_MESSAGE = 'Verify your email to share publicly';

export const ESTABLISHED_AFTER_DAYS = 14;

// The cutoff for the verified -> established sweep: orgs created before it
// on a paid plan have been around long enough.
export const establishedCutoff = (now: Date) =>
	new Date(
		now.getTime() - ESTABLISHED_AFTER_DAYS * 24 * 60 * 60 * 1000
	).toISOString();
