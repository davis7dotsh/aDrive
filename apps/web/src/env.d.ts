// Secrets come from .dev.vars locally and `wrangler secret put` in
// production; `wrangler types` only declares them when .dev.vars has them,
// so they are pinned here for clean checkouts.
declare global {
	interface Env {
		MAINTENANCE_SECRET: string;
		WORKOS_API_KEY?: string;
		WORKOS_DEV_FAKE?: string;
		WORKOS_CLIENT_ID?: string;
		WORKOS_COOKIE_PASSWORD?: string;
		WORKOS_WEBHOOK_SECRET?: string;
		// Abuse controls (docs/abuse.md). All optional: the Null services
		// stand in when unset.
		ADMIN_USER_IDS?: string;
		URLSCAN_API_KEY?: string;
		CF_ACCOUNT_ID?: string;
		CF_API_TOKEN?: string;
		CF_ZONE_ID?: string;
		AUTUMN_SECRET_KEY?: string;
		AUTUMN_WEBHOOK_SECRET?: string;
	}

	namespace Cloudflare {
		interface Env {
			MAINTENANCE_SECRET: string;
			WORKOS_API_KEY?: string;
			WORKOS_DEV_FAKE?: string;
			WORKOS_CLIENT_ID?: string;
			WORKOS_COOKIE_PASSWORD?: string;
			WORKOS_WEBHOOK_SECRET?: string;
			ADMIN_USER_IDS?: string;
			URLSCAN_API_KEY?: string;
			CF_ACCOUNT_ID?: string;
			CF_API_TOKEN?: string;
			CF_ZONE_ID?: string;
			AUTUMN_SECRET_KEY?: string;
			AUTUMN_WEBHOOK_SECRET?: string;
		}
	}
}

export {};
