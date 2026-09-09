// Secrets come from .dev.vars locally and `wrangler secret put` in
// production; `wrangler types` only declares them when .dev.vars has them,
// so they are pinned here for clean checkouts.
declare global {
	interface Env {
		MAINTENANCE_SECRET: string;
		WORKOS_API_KEY?: string;
		WORKOS_CLIENT_ID?: string;
		WORKOS_COOKIE_PASSWORD?: string;
		WORKOS_WEBHOOK_SECRET?: string;
	}

	namespace Cloudflare {
		interface Env {
			MAINTENANCE_SECRET: string;
			WORKOS_API_KEY?: string;
			WORKOS_CLIENT_ID?: string;
			WORKOS_COOKIE_PASSWORD?: string;
			WORKOS_WEBHOOK_SECRET?: string;
		}
	}
}

export {};
