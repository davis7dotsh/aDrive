// Replaced by esbuild --define at release build time; running from
// source (strip-types) leaves it undefined and falls back to "dev".
declare const __ADRIVE_VERSION__: string | undefined;
export const CLI_VERSION =
	typeof __ADRIVE_VERSION__ === 'string' ? __ADRIVE_VERSION__ : 'dev';
