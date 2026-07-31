import { vitePreprocess } from '@sveltejs/vite-plugin-svelte';
import { withScheduledLifecycle } from './scripts/cloudflare-adapter.mjs';

/** @type {import('@sveltejs/kit').Config} */
const config = {
	preprocess: vitePreprocess(),
	kit: {
		// Kept minimal on purpose: this exists so SvelteKit emits a per-request
		// nonce for its inline hydration script. hooks.server.ts rewrites the
		// final policy with the runtime content origin (see security-headers.ts).
		csp: {
			mode: 'nonce',
			directives: {
				'script-src': ['self']
			}
		},
		adapter: withScheduledLifecycle({
			platformProxy: {
				configPath: 'wrangler.jsonc',
				persist: true,
				remoteBindings: false
			}
		})
	}
};

export default config;
