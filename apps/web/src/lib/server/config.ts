import { dev } from '$app/environment';
import { Context, Layer } from 'effect';
import { contentOriginFor, normalizeOrigins } from './host-gate';

// A null API key is reserved for the explicitly enabled development fake.
// Production always requires real WorkOS credentials.
export interface WorkOSConfig {
	readonly apiKey: string | null;
	readonly clientId: string;
	readonly cookiePassword: string;
	readonly webhookSecret: string;
}

// Cloudflare URL Scanner (services/url-reputation.ts). Null when
// URLSCAN_API_KEY is unset; a `fake:<verdict>` key selects the fake.
export interface UrlScannerConfig {
	readonly apiKey: string;
	readonly accountId: string;
}

// Zone-level cache purge (services/cache-purge.ts). Null when either
// CF_API_TOKEN or CF_ZONE_ID is unset.
export interface CloudflareZoneConfig {
	readonly apiToken: string;
	readonly zoneId: string;
}

export interface AppConfigShape {
	readonly dashboardOrigin: string;
	// Tenant content is served from `<slug>.<contentDomain>` over the
	// dashboard's scheme; contentOriginFor builds one org's origin.
	readonly contentDomain: string;
	readonly contentScheme: string;
	readonly contentOriginFor: (slug: string) => string;
	readonly maxUploadBytes: number;
	// Signs the Worker facade's cron and queue self-requests.
	readonly maintenanceSecret: string;
	readonly workos: WorkOSConfig;
	readonly urlScanner: UrlScannerConfig | null;
	readonly cloudflareZone: CloudflareZoneConfig | null;
	// WorkOS user ids allowed on /admin (ADMIN_USER_IDS, comma-separated).
	readonly adminUserIds: ReadonlySet<string>;
	readonly semanticSearch: 'off' | 'auto' | 'required';
	readonly embeddingModel: '@cf/baai/bge-small-en-v1.5';
	readonly embeddingPooling: 'cls';
	readonly embeddingDimensions: 384;
}

export class AppConfig extends Context.Service<AppConfig, AppConfigShape>()(
	'app/AppConfig'
) {}

const semanticMode = (value: string) => {
	switch (value) {
		case 'off':
		case 'auto':
		case 'required':
			return value;
		default:
			throw new Error('SEMANTIC_SEARCH must be off, auto, or required');
	}
};

const optionalString = (value: unknown) =>
	typeof value === 'string' ? value : '';

const isFakeWorkOSKey = (apiKey: string) =>
	apiKey === '' || apiKey.startsWith('fake:');

const workosFromEnv = (env: Env): WorkOSConfig => {
	const rawApiKey = optionalString(env.WORKOS_API_KEY).trim();
	const clientId = optionalString(env.WORKOS_CLIENT_ID);
	const cookiePassword = optionalString(env.WORKOS_COOKIE_PASSWORD);
	const webhookSecret = optionalString(env.WORKOS_WEBHOOK_SECRET);
	if (isFakeWorkOSKey(rawApiKey)) {
		if (dev && env.WORKOS_DEV_FAKE === 'true') {
			return { apiKey: null, clientId, cookiePassword, webhookSecret };
		}
		throw new Error(
			'WORKOS_API_KEY is required; fake authentication requires WORKOS_DEV_FAKE=true in development'
		);
	}
	if (!clientId) {
		throw new Error('WORKOS_CLIENT_ID is required alongside WORKOS_API_KEY');
	}
	if (cookiePassword.length < 32) {
		throw new Error(
			'WORKOS_COOKIE_PASSWORD must contain at least 32 characters'
		);
	}
	if (!webhookSecret) {
		throw new Error(
			'WORKOS_WEBHOOK_SECRET is required alongside WORKOS_API_KEY'
		);
	}
	return { apiKey: rawApiKey, clientId, cookiePassword, webhookSecret };
};

const urlScannerFromEnv = (env: Env): UrlScannerConfig | null => {
	const apiKey = optionalString(env.URLSCAN_API_KEY);
	if (apiKey === '') return null;
	const accountId = optionalString(env.CF_ACCOUNT_ID);
	if (!accountId && !apiKey.startsWith('fake:')) {
		throw new Error('CF_ACCOUNT_ID is required alongside URLSCAN_API_KEY');
	}
	return { apiKey, accountId };
};

const cloudflareZoneFromEnv = (env: Env): CloudflareZoneConfig | null => {
	const apiToken = optionalString(env.CF_API_TOKEN);
	const zoneId = optionalString(env.CF_ZONE_ID);
	return apiToken && zoneId ? { apiToken, zoneId } : null;
};

const adminUserIdsFromEnv = (env: Env) =>
	new Set(
		optionalString(env.ADMIN_USER_IDS)
			.split(',')
			.map((id) => id.trim())
			.filter((id) => id.length > 0)
	);

export const configFromEnv = (env: Env) => {
	const origins = normalizeOrigins({
		dashboardOrigin: env.DASHBOARD_ORIGIN,
		contentDomain: env.CONTENT_DOMAIN
	});
	const maxUploadBytes = Number(env.MAX_UPLOAD_BYTES);
	if (!Number.isSafeInteger(maxUploadBytes) || maxUploadBytes <= 0) {
		throw new Error('MAX_UPLOAD_BYTES must be a positive safe integer');
	}

	if (
		typeof env.MAINTENANCE_SECRET !== 'string' ||
		env.MAINTENANCE_SECRET.length < 12
	) {
		throw new Error('MAINTENANCE_SECRET must contain at least 12 characters');
	}
	const semanticSearch = semanticMode(String(env.SEMANTIC_SEARCH));
	if (env.EMBEDDING_MODEL !== '@cf/baai/bge-small-en-v1.5') {
		throw new Error('EMBEDDING_MODEL must stay pinned to bge-small-en-v1.5');
	}
	if (env.EMBEDDING_POOLING !== 'cls') {
		throw new Error('EMBEDDING_POOLING must stay pinned to cls');
	}
	if (env.EMBEDDING_DIMENSIONS !== '384') {
		throw new Error('EMBEDDING_DIMENSIONS must stay pinned to 384');
	}
	return {
		...origins,
		contentOriginFor: (slug: string) =>
			contentOriginFor(origins.contentScheme, origins.contentDomain, slug),
		maxUploadBytes,
		maintenanceSecret: env.MAINTENANCE_SECRET,
		workos: workosFromEnv(env),
		urlScanner: urlScannerFromEnv(env),
		cloudflareZone: cloudflareZoneFromEnv(env),
		adminUserIds: adminUserIdsFromEnv(env),
		semanticSearch,
		embeddingModel: '@cf/baai/bge-small-en-v1.5',
		embeddingPooling: 'cls',
		embeddingDimensions: 384
	} satisfies AppConfigShape;
};

export const ConfigLive = (env: Env) =>
	Layer.succeed(AppConfig, configFromEnv(env));
