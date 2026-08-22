import { Effect } from 'effect';
import { CliConfigSchema } from './config-schema.ts';
import { CliFailure } from './errors.ts';

const LOCAL_HOSTNAMES = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

export const isLocalHostname = (hostname: string) =>
	LOCAL_HOSTNAMES.has(hostname) || hostname.endsWith('.localhost');

export const assertSecureUrl = (
	url: URL,
	allowHttp: boolean,
	label: string
) => {
	if (url.protocol === 'https:') return;
	if (url.protocol === 'http:' && isLocalHostname(url.hostname)) return;
	if (url.protocol === 'http:' && allowHttp) return;
	throw new Error(
		`${label} must use https (or http on localhost). ` +
			'Pass --allow-http at login only for trusted private networks.'
	);
};

export const normalizeEndpoint = (value: string, allowHttp: boolean) => {
	const url = new URL(value);
	if (
		!['http:', 'https:'].includes(url.protocol) ||
		url.pathname !== '/' ||
		url.search ||
		url.hash
	) {
		throw new Error('The server URL must be an http(s) origin without a path');
	}
	assertSecureUrl(url, allowHttp, 'The server URL');
	return url.origin;
};

// Server-returned URLs are only trusted on origins the user configured:
// the endpoint itself, or the content origin recorded at login. Anything
// else is rejected before the CLI fetches it or opens a browser to it.
export const assertTrustedServerUrl = (
	value: string,
	config: typeof CliConfigSchema.Type,
	label: string
) => {
	const url = new URL(value);
	assertSecureUrl(url, config.allowHttp === true, label);
	const trusted = [config.endpoint, config.contentOrigin].filter(
		(origin): origin is string => typeof origin === 'string'
	);
	if (!trusted.includes(url.origin)) {
		throw new Error(
			`${label} points at an unexpected origin (${url.origin}). ` +
				'Re-run `adrive login` if the server moved.'
		);
	}
	return value;
};

export const trustedServerUrl = (
	value: string,
	config: typeof CliConfigSchema.Type,
	label: string
) =>
	Effect.try({
		try: () => assertTrustedServerUrl(value, config, label),
		catch: (cause) =>
			new CliFailure({
				message: cause instanceof Error ? cause.message : `${label} is invalid`,
				cause
			})
	});
