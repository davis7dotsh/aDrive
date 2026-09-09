import tailwindcss from '@tailwindcss/vite';
import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig } from 'vite';

// The test.exclude override is valid vitest config; vite's own types flag
// it because the merged config type is loose. Cast keeps tsc quiet.
export default defineConfig({
	plugins: [tailwindcss(), sveltekit()],
	server: {
		// The dev server binds 0.0.0.0 so other devices can reach it; allow
		// any hostname since the app's own host gate enforces the origins.
		allowedHosts: true
	},
	test: {
		exclude: [
			'**/node_modules/**',
			'src/lib/server/routes/**',
			'**/*.pg.test.ts',
			'**/*.svelte.test.ts'
		]
	}
} as import('vite').UserConfig);
