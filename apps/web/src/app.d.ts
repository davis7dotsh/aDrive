import type { Env } from '../worker-configuration';
import type { AuthContext } from '$lib/server/identity';

declare global {
	namespace App {
		interface Locals {
			// Resolved once per request by hooks.server.ts from the adr_
			// bearer key or the session cookie; null when neither is valid.
			auth: AuthContext | null;
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
