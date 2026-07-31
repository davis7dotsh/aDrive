import { classifyRoute } from './host-gate';

export interface SecurityHeaderContext {
	readonly pathname: string;
	readonly requestOrigin: string;
	readonly contentOrigin: string;
}

const HSTS_VALUE = 'max-age=31536000; includeSubDomains';

// The dashboard loads previews (images, media, iframes) and fetches nothing
// cross-origin except content served from CONTENT_ORIGIN. SvelteKit emits a
// nonce'd script-src for its hydration script (svelte.config.js); every other
// directive is owned here so the content origin can come from runtime config.
const dashboardCsp = (contentOrigin: string, scriptSrc: string) =>
	[
		`default-src 'self'`,
		scriptSrc,
		`style-src 'self' 'unsafe-inline'`,
		`img-src 'self' data: blob: ${contentOrigin}`,
		`media-src 'self' blob: ${contentOrigin}`,
		`connect-src 'self' ${contentOrigin}`,
		`frame-src ${contentOrigin}`,
		`object-src 'none'`,
		`base-uri 'self'`,
		`form-action 'self'`,
		`frame-ancestors 'none'`
	].join('; ');

const extractScriptSrc = (existingCsp: string | null) => {
	const fallback = `script-src 'self'`;
	if (!existingCsp) return fallback;
	const directive = existingCsp
		.split(';')
		.map((part) => part.trim())
		.find((part) => part.startsWith('script-src '));
	return directive ?? fallback;
};

export const applySecurityHeaders = (
	response: Response,
	context: SecurityHeaderContext
) => {
	const headers = response.headers;
	const route = classifyRoute(context.pathname);
	const isHtml = (headers.get('Content-Type') ?? '').includes('text/html');

	if (context.requestOrigin.startsWith('https://')) {
		headers.set('Strict-Transport-Security', HSTS_VALUE);
	}
	if (!headers.has('X-Content-Type-Options')) {
		headers.set('X-Content-Type-Options', 'nosniff');
	}
	if (!headers.has('Referrer-Policy')) {
		headers.set('Referrer-Policy', 'strict-origin-when-cross-origin');
	}
	if (!headers.has('Permissions-Policy')) {
		headers.set(
			'Permissions-Policy',
			'camera=(), microphone=(), geolocation=(), payment=(), usb=()'
		);
	}

	// Every dashboard API response carries account or credential data;
	// content routes (/f, /s) own their own caching policy per file.
	if (context.pathname.startsWith('/api/') && !headers.has('Cache-Control')) {
		headers.set('Cache-Control', 'private, no-store');
	}

	// Content routes (/f, /s) set a per-file CSP in their handlers; leave it.
	// Dashboard pages get the full policy, preserving SvelteKit's nonce.
	if (route === 'dashboard' && isHtml) {
		headers.set(
			'Content-Security-Policy',
			dashboardCsp(
				context.contentOrigin,
				extractScriptSrc(headers.get('Content-Security-Policy'))
			)
		);
	}

	return response;
};
