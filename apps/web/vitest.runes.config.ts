import { sveltekit } from '@sveltejs/kit/vite';
import tailwindcss from '@tailwindcss/vite';
import { defineConfig } from 'vitest/config';

// Runes-module tests: Svelte's client runtime only activates under the
// browser export condition with a DOM present, so $effect.root actually
// runs its callback. Kept separate from the default project, whose tests
// must stay on the server runtime.
export default defineConfig({
	plugins: [tailwindcss(), sveltekit()],
	resolve: {
		conditions: ['browser']
	},
	test: {
		environment: 'happy-dom',
		include: ['src/lib/**/*.svelte.test.ts'],
		testTimeout: 15_000
	}
});
