import { MisdirectedRequest } from './errors';

export interface OriginConfig {
	readonly dashboardOrigin: string;
	readonly contentOrigin: string;
}

const origin = (value: string, label: string) => {
	const parsed = new URL(value);
	if (parsed.pathname !== '/' || parsed.search || parsed.hash) {
		throw new Error(
			`${label} must be an origin without a path, query, or fragment`
		);
	}
	return parsed.origin;
};

export const normalizeOrigins = (config: OriginConfig) => {
	const dashboardOrigin = origin(config.dashboardOrigin, 'DASHBOARD_ORIGIN');
	const contentOrigin = origin(config.contentOrigin, 'CONTENT_ORIGIN');
	if (dashboardOrigin === contentOrigin) {
		throw new Error('DASHBOARD_ORIGIN and CONTENT_ORIGIN must be different');
	}
	return { dashboardOrigin, contentOrigin };
};

export const classifyRoute = (pathname: string) =>
	pathname === '/f' ||
	pathname.startsWith('/f/') ||
	pathname === '/s' ||
	pathname.startsWith('/s/')
		? 'content'
		: 'dashboard';

export const assertHostRoute = (requestUrl: URL, config: OriginConfig) => {
	const origins = normalizeOrigins(config);
	const route = classifyRoute(requestUrl.pathname);
	const requestOrigin = requestUrl.origin;
	const expectedOrigin =
		route === 'content' ? origins.contentOrigin : origins.dashboardOrigin;

	if (requestOrigin !== expectedOrigin) {
		throw new MisdirectedRequest({
			message: `This route belongs on the ${route} origin`
		});
	}
};
