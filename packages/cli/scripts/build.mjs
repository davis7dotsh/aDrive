// Bundles the CLI into a single executable ESM file. The version comes
// from ADRIVE_CLI_VERSION (set by the release workflow from the git tag);
// local builds get 0.0.0-local so a stray artifact is never mistaken for
// a release.
import { chmod } from 'node:fs/promises';
import { build } from 'esbuild';

const version = process.env.ADRIVE_CLI_VERSION ?? '0.0.0-local';
if (!/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(version)) {
	console.error(`ADRIVE_CLI_VERSION is not a valid semver: ${version}`);
	process.exit(1);
}

await build({
	entryPoints: ['src/main.ts'],
	bundle: true,
	platform: 'node',
	format: 'esm',
	target: 'node20',
	outfile: 'dist/adrive.mjs',
	banner: {
		// CJS deps in the graph (yaml, via effect's CLI config loading)
		// call require() for node builtins; ESM output needs a real
		// require in scope for esbuild's CJS interop to use.
		js: [
			'#!/usr/bin/env node',
			'import { createRequire as __createRequire } from "node:module";',
			'const require = __createRequire(import.meta.url);'
		].join('\n')
	},
	define: { __ADRIVE_VERSION__: JSON.stringify(version) },
	// Belt and braces: deep imports already avoid the NodeRedis barrel
	// path, but never let the redis client into the bundle regardless.
	external: ['ioredis'],
	logLevel: 'info'
});

await chmod('dist/adrive.mjs', 0o755);
