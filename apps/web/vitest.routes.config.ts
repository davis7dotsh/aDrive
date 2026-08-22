import { sveltekit } from '@sveltejs/kit/vite';
import tailwindcss from '@tailwindcss/vite';
import { defineConfig } from 'vite';

// Route-level integration tests: real bindings via getPlatformProxy, one
// worker process so every suite starts from freshly migrated local state.
export default defineConfig({
	plugins: [tailwindcss(), sveltekit()],
	test: {
		globalSetup: ['./src/lib/server/routes/global-setup.ts'],
		setupFiles: ['./src/lib/server/test/setup.ts'],
		include: ['src/lib/server/routes/**/*.test.ts'],
		fileParallelism: false,
		testTimeout: 30_000
	}
});
