// File details accept dashboard return locations, including the old query-only
// form. Keep the path allowlist narrow so `from` cannot link off-site or to an
// unrelated application route.
export const dashboardReturnHref = (from: string | null | undefined) => {
	const href = from?.startsWith('?') ? `/${from}` : (from ?? '/');
	if (/[\u0000-\u001f\u007f]/.test(href)) return '/';
	return /^\/[a-e]?(?:\?[^#]*)?$/i.test(href) ? href : '/';
};
