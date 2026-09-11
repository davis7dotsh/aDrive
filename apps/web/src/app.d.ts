import type { Env } from '../worker-configuration';
import type { ContentHost } from '$lib/server/content-host';
import type { AuthContext } from '$lib/server/identity';

declare global {
	namespace App {
		// Set by the root layout load for every page.
		interface PageData {
			session?: {
				readonly user: { readonly email: string };
				readonly role: AuthContext['role'];
				readonly org: { readonly name: string; readonly slug: string };
			} | null;
		}
		interface Locals {
			// Resolved once per request by hooks.server.ts from the adr_
			// bearer key or the session cookie; null when neither is valid.
			auth: AuthContext | null;
			// The org whose content host (`<slug>.<content domain>`) the
			// request arrived on; null on the dashboard origin. The hook
			// answers 404 before any content route runs for a host that
			// names no live org.
			content: ContentHost | null;
		}
		interface Platform {
			env: Env;
			ctx: ExecutionContext;
			caches: CacheStorage;
			cf: IncomingRequestCfProperties;
		}
	}
}

export {};
