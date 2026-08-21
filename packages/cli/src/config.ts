import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { Effect, Schema } from 'effect';
import { CliConfigSchema, type CliConfig } from './config-schema.ts';
import { CliFailure } from './errors.ts';
import { assertSecureUrl } from './url-trust.ts';

export const configPath = () =>
	join(
		process.env.XDG_CONFIG_HOME ?? join(homedir(), '.config'),
		'adrive',
		'config.json'
	);

export const saveConfig = (config: CliConfig) =>
	Effect.tryPromise({
		try: async () => {
			const path = configPath();
			await mkdir(dirname(path), { recursive: true, mode: 0o700 });
			await writeFile(path, `${JSON.stringify(config, null, 2)}\n`, {
				mode: 0o600
			});
			await chmod(path, 0o600);
		},
		catch: (cause) =>
			new CliFailure({ message: 'Could not save credentials', cause })
	});

// The deployment's content origin is learned from the authenticated list
// endpoint. It must clear the same transport bar as the endpoint itself
// before joining the trust list; an insecure advertisement is discarded.
export const discoverContentOrigin = async (
	endpoint: string,
	apiKey: string,
	allowHttp: boolean
) => {
	const response = await fetch(`${endpoint}/api/files`, {
		headers: { authorization: `Bearer ${apiKey}` }
	});
	if (!response.ok) return undefined;
	const body: unknown = await response.json();
	if (
		typeof body === 'object' &&
		body !== null &&
		'contentOrigin' in body &&
		typeof body.contentOrigin === 'string'
	) {
		const origin = new URL(body.contentOrigin);
		assertSecureUrl(
			origin,
			allowHttp,
			'The content origin advertised by the server'
		);
		return origin.origin;
	}
	return undefined;
};

// Configs written before contentOrigin was recorded learn it on demand,
// then persist it.
export const withContentOrigin = (config: CliConfig) =>
	config.contentOrigin !== undefined
		? Effect.succeed(config)
		: Effect.tryPromise({
				try: async () => {
					const discovered = await discoverContentOrigin(
						config.endpoint,
						config.apiKey,
						config.allowHttp === true
					);
					return discovered !== undefined
						? { ...config, contentOrigin: discovered }
						: config;
				},
				catch: (cause) =>
					new CliFailure({
						message:
							cause instanceof Error
								? cause.message
								: 'Could not reach the server to confirm its origins',
						cause
					})
			}).pipe(
				Effect.tap((updated) =>
					updated.contentOrigin !== undefined
						? saveConfig(updated).pipe(Effect.ignore)
						: Effect.void
				)
			);

export const loadConfig = Effect.tryPromise({
	try: () => readFile(configPath(), 'utf8'),
	catch: () =>
		new CliFailure({
			message: 'Not logged in. Run `adrive login <server-url>` first.'
		})
}).pipe(
	Effect.flatMap((text) =>
		Effect.try({
			try: () => JSON.parse(text),
			catch: (cause) =>
				new CliFailure({
					message: 'The adrive config file is not valid JSON',
					cause
				})
		})
	),
	Effect.flatMap(Schema.decodeUnknownEffect(CliConfigSchema)),
	Effect.mapError((cause) =>
		cause instanceof CliFailure
			? cause
			: new CliFailure({ message: 'Could not read credentials', cause })
	),
	Effect.flatMap((config) =>
		Effect.try({
			try: () => {
				assertSecureUrl(
					new URL(config.endpoint),
					config.allowHttp === true,
					'The configured server URL'
				);
				return config;
			},
			catch: (cause) =>
				new CliFailure({
					message:
						cause instanceof Error
							? `${cause.message} Re-run \`adrive login\`.`
							: 'The configured server URL is invalid',
					cause
				})
		})
	)
);
