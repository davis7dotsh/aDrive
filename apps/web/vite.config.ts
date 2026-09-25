import tailwindcss from '@tailwindcss/vite';
import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig } from 'vite';

export default defineConfig({
	plugins: [tailwindcss(), sveltekit()],
	server: {
		// The dev server binds 0.0.0.0 so other devices can reach it; allow
		// any hostname since the app's own host gate enforces the origins.
		allowedHosts: true
	}
});
