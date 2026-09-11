import { MisdirectedRequest } from './errors';

export interface OriginConfig {
	readonly dashboardOrigin: string;
	// Host (and optional port) under which every org's content lives:
	// `<slug>.<contentDomain>`. No scheme; the scheme follows the dashboard.
	readonly contentDomain: string;
}

// The leading host label a content request is allowed to carry. The slug
// policy (slug-policy.ts) is stricter for slugs an owner may choose; the
// gate also accepts longer slugs generated before the owner policy was
// introduced, up to the DNS label limit. Existing URLs keep working.
const HOST_SLUG_PATTERN = /^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/;

const origin = (value: string, label: string) => {
	const parsed = new URL(value);
	if (parsed.pathname !== '/' || parsed.search || parsed.hash) {
		throw new Error(
			`${label} must be an origin without a path, query, or fragment`
		);
	}
	return parsed.origin;
};

const domain = (value: string, label: string) => {
	const parsed = (() => {
		try {
			return new URL(`http://${value}/`);
		} catch {
			return null;
		}
	})();
	if (
		parsed === null ||
		parsed.host !== value ||
		value.includes('/') ||
		value.includes('@')
	) {
		throw new Error(
			`${label} must be a bare hostname with an optional port, like files.example`
		);
	}
	return parsed.host;
};

export const normalizeOrigins = (config: OriginConfig) => {
	const dashboardOrigin = origin(config.dashboardOrigin, 'DASHBOARD_ORIGIN');
	const contentDomain = domain(config.contentDomain, 'CONTENT_DOMAIN');
	const dashboard = new URL(dashboardOrigin);
	if (
		dashboard.host === contentDomain ||
		dashboard.host.endsWith(`.${contentDomain}`)
	) {
		throw new Error('DASHBOARD_ORIGIN must not live under CONTENT_DOMAIN');
	}
	return {
		dashboardOrigin,
		contentDomain,
		contentScheme: dashboard.protocol
	};
};

export const classifyRoute = (pathname: string) =>
	pathname === '/f' ||
	pathname.startsWith('/f/') ||
	pathname === '/t' ||
	pathname.startsWith('/t/') ||
	pathname === '/s' ||
	pathname.startsWith('/s/')
		? 'content'
		: 'dashboard';

// The org slug named by a request host, or null when the host is not a
// single label under the content domain.
export const contentSlugFromHost = (host: string, contentDomain: string) => {
	const suffix = `.${contentDomain.toLowerCase()}`;
	const lowered = host.toLowerCase();
	if (!lowered.endsWith(suffix)) return null;
	const slug = lowered.slice(0, -suffix.length);
	return HOST_SLUG_PATTERN.test(slug) ? slug : null;
};

export const contentOriginFor = (
	contentScheme: string,
	contentDomain: string,
	slug: string
) => `${contentScheme}//${slug}.${contentDomain}`;

export type HostRoute =
	| { readonly route: 'dashboard' }
	| { readonly route: 'content'; readonly slug: string };

// Content routes must arrive on `<slug>.<contentDomain>`, dashboard routes
// on the dashboard origin exactly. Anything else is a 421 candidate.
export const assertHostRoute = (
	requestUrl: URL,
	config: OriginConfig
): HostRoute => {
	const origins = normalizeOrigins(config);
	const route = classifyRoute(requestUrl.pathname);
	if (route === 'dashboard') {
		if (requestUrl.origin !== origins.dashboardOrigin) {
			throw new MisdirectedRequest({
				message: 'This route belongs on the dashboard origin'
			});
		}
		return { route };
	}
	const slug =
		requestUrl.protocol === origins.contentScheme
			? contentSlugFromHost(requestUrl.host, origins.contentDomain)
			: null;
	if (slug === null) {
		throw new MisdirectedRequest({
			message: 'This route belongs on the content origin'
		});
	}
	return { route, slug };
};
