import type { Env } from '../worker-configuration';

declare global {
	namespace App {
		interface Platform {
			env: Env;
			ctx: ExecutionContext;
			caches: CacheStorage;
			cf: IncomingRequestCfProperties;
		}
	}
}

export {};
