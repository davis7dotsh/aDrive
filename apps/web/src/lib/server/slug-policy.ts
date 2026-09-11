// Rules for the label an org's content is served under
// (`<slug>.<CONTENT_DOMAIN>`). The host gate accepts a superset of this
// (DNS-valid labels of 3-63 characters) so old slugs keep working; only
// slugs an owner may choose go through validateSlug.

export const SLUG_MIN_LENGTH = 3;
export const SLUG_MAX_LENGTH = 32;
const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

// Labels that would read as ours, or as infrastructure, on the content
// domain. Kept short on purpose: a slug is a hostname label, nothing more.
export const RESERVED_SLUGS: ReadonlySet<string> = new Set([
	'www',
	'api',
	'admin',
	'app',
	'mail',
	'static',
	'cdn',
	'files',
	'drive',
	'assets',
	'status',
	'help',
	'support',
	'login',
	'signup',
	'billing',
	'dashboard'
]);

// One change per 30 days, and the old slug keeps redirecting for as long.
export const SLUG_CHANGE_INTERVAL_MS = 30 * 24 * 60 * 60 * 1_000;
export const SLUG_REDIRECT_WINDOW_MS = SLUG_CHANGE_INTERVAL_MS;

export type SlugValidation =
	| { readonly ok: true; readonly slug: string }
	| { readonly ok: false; readonly message: string };

export const validateSlug = (value: string): SlugValidation => {
	const slug = value.trim().toLowerCase();
	if (slug.length < SLUG_MIN_LENGTH || slug.length > SLUG_MAX_LENGTH) {
		return {
			ok: false,
			message: `A slug is ${SLUG_MIN_LENGTH} to ${SLUG_MAX_LENGTH} characters`
		};
	}
	if (!SLUG_PATTERN.test(slug)) {
		return {
			ok: false,
			message:
				'A slug uses lowercase letters, digits, and hyphens, and cannot start or end with a hyphen'
		};
	}
	if (RESERVED_SLUGS.has(slug)) {
		return { ok: false, message: 'That slug is reserved' };
	}
	return { ok: true, slug };
};

// When an org may change its slug again, or null when it may now.
export const nextSlugChangeAt = (
	slugChangedAt: string | null,
	now: Date = new Date()
) => {
	if (slugChangedAt === null) return null;
	const allowedAt = new Date(slugChangedAt).getTime() + SLUG_CHANGE_INTERVAL_MS;
	return allowedAt > now.getTime() ? new Date(allowedAt).toISOString() : null;
};
