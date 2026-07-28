import { vitePreprocess } from '@sveltejs/vite-plugin-svelte';
import { withScheduledLifecycle } from './scripts/cloudflare-adapter.mjs';

/** @type {import('@sveltejs/kit').Config} */
const config = {
	preprocess: vitePreprocess(),
	kit: {
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
