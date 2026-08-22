import tailwindcss from '@tailwindcss/vite';
import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig } from 'vite';

// The test.exclude override is valid vitest config; vite's own types flag
// it because the merged config type is loose. Cast keeps tsc quiet.
export default defineConfig({
	plugins: [tailwindcss(), sveltekit()],
	test: {
		exclude: [
			'**/node_modules/**',
			'src/lib/server/routes/**',
			'**/*.svelte.test.ts'
		]
	}
} as import('vite').UserConfig);
