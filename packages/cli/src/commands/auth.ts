import {
	DeviceAuthorizationResponseSchema,
	DevicePendingResponseSchema,
	DeviceTokenResponseSchema
} from '@adrive/shared';
import { spawn } from 'node:child_process';
import { Console, Effect, Schema } from 'effect';
import { Argument, Command, Flag } from 'effect/unstable/cli';
import {
	configPath,
	discoverContentOrigin,
	loadConfig,
	saveConfig
} from '../config.ts';
import { CliFailure } from '../errors.ts';
import { responseError } from '../http.ts';
import { emit, wantsJson } from '../output.ts';
import { normalizeEndpoint, trustedServerUrl } from '../url-trust.ts';

const openBrowser = (url: string) =>
	Effect.tryPromise({
		try: () =>
			new Promise<void>((resolve, reject) => {
				const command =
					process.platform === 'darwin'
						? 'open'
						: process.platform === 'win32'
							? 'cmd'
							: 'xdg-open';
				const args =
					process.platform === 'win32' ? ['/c', 'start', '', url] : [url];
				const child = spawn(command, args, {
					detached: true,
					stdio: 'ignore'
				});
				child.once('error', reject);
				child.once('spawn', () => {
					child.unref();
					resolve();
				});
			}),
		catch: (cause) =>
			new CliFailure({ message: 'Could not open a browser', cause })
	});

export const login = Command.make(
	'login',
	{
		endpoint: Argument.string('server-url'),
		headless: Flag.boolean('headless').pipe(
			Flag.withDescription('Print the approval URL without opening a browser')
		),
		allowHttp: Flag.boolean('allow-http').pipe(
			Flag.withDescription(
				'Allow a plain-http server on a trusted private network'
			)
		),
		name: Flag.string('name').pipe(
			Flag.withDefault('adrive CLI'),
			Flag.withDescription('Name for the full-access key created on approval')
		)
	},
	({ endpoint: rawEndpoint, headless, allowHttp, name }) =>
		Effect.gen(function* () {
			const endpoint = yield* Effect.try({
				try: () => normalizeEndpoint(rawEndpoint, allowHttp),
				catch: (cause) =>
					new CliFailure({
						message:
							cause instanceof Error
								? cause.message
								: 'The server URL is invalid',
						cause
					})
			});
			const authorizationBody = yield* Effect.tryPromise({
				try: async () => {
					const response = await fetch(`${endpoint}/api/auth/device`, {
						method: 'POST',
						headers: { 'Content-Type': 'application/json' },
						body: JSON.stringify({ name })
					});
					if (!response.ok) throw new Error(await responseError(response));
					return response.json();
				},
				catch: (cause) =>
					new CliFailure({
						message:
							cause instanceof Error
								? cause.message
								: 'Could not start device authorization',
						cause
					})
			});
			const authorization = yield* Schema.decodeUnknownEffect(
				DeviceAuthorizationResponseSchema
			)(authorizationBody).pipe(
				Effect.mapError(
					(cause) =>
						new CliFailure({
							message: 'The server returned an invalid device authorization',
							cause
						})
				)
			);
			// The approval URL is opened in a browser where the dashboard
			// session lives; never follow it to an origin we didn't dial.
			yield* trustedServerUrl(
				authorization.verificationUriComplete,
				{ endpoint, apiKey: '', allowHttp },
				'The verification URL returned by the server'
			);
			if (wantsJson()) {
				yield* emit({
					status: 'authorization_required',
					userCode: authorization.userCode,
					verificationUri: authorization.verificationUri,
					verificationUriComplete: authorization.verificationUriComplete
				});
			} else {
				yield* Console.log(
					`Approve this device with code ${authorization.userCode}`
				);
				yield* Console.log(authorization.verificationUriComplete);
				if (!headless) {
					yield* openBrowser(authorization.verificationUriComplete).pipe(
						Effect.catch(() =>
							Console.error(
								'Could not open a browser; open the URL above on any machine.'
							)
						)
					);
				}
			}

			let apiKey = '';
			while (!apiKey) {
				yield* Effect.sleep(`${authorization.interval} seconds`);
				const pollResponse = yield* Effect.tryPromise({
					try: async () => {
						const response = await fetch(`${endpoint}/api/auth/device/token`, {
							method: 'POST',
							headers: { 'Content-Type': 'application/json' },
							body: JSON.stringify({
								deviceCode: authorization.deviceCode
							})
						});
						const body: unknown = await response.json();
						if (response.status === 202 || response.status === 429) {
							return { kind: 'pending' as const, body };
						}
						if (response.ok) return { kind: 'complete' as const, body };
						throw new Error(`Device authorization failed (${response.status})`);
					},
					catch: (cause) =>
						new CliFailure({
							message:
								cause instanceof Error
									? cause.message
									: 'Could not poll device authorization',
							cause
						})
				});
				const poll =
					pollResponse.kind === 'complete'
						? yield* Schema.decodeUnknownEffect(DeviceTokenResponseSchema)(
								pollResponse.body
							).pipe(
								Effect.mapError(
									(cause) =>
										new CliFailure({
											message: 'The server returned an invalid API key',
											cause
										})
								)
							)
						: yield* Schema.decodeUnknownEffect(DevicePendingResponseSchema)(
								pollResponse.body
							).pipe(
								Effect.mapError(
									(cause) =>
										new CliFailure({
											message:
												'The server returned an invalid authorization status',
											cause
										})
								)
							);
				if ('apiKey' in poll) {
					apiKey = poll.apiKey;
				} else if (poll.status === 'slow_down') {
					yield* Effect.sleep(`${authorization.interval} seconds`);
				}
			}
			// Record the deployment's content origin so later commands can
			// verify that server-returned download URLs stay on known ground.
			const contentOrigin = yield* Effect.tryPromise({
				try: () => discoverContentOrigin(endpoint, apiKey, allowHttp),
				catch: () => new CliFailure({ message: 'unreachable' })
			}).pipe(Effect.orElseSucceed(() => undefined));
			yield* saveConfig({
				endpoint,
				apiKey,
				...(contentOrigin ? { contentOrigin } : {}),
				...(allowHttp ? { allowHttp } : {})
			});
			yield* emit(
				wantsJson()
					? { status: 'authenticated', endpoint }
					: `Logged in to ${endpoint}`
			);
		})
).pipe(Command.withDescription('Authorize this CLI through the dashboard'));

export const whoami = Command.make('whoami', {}, () =>
	Effect.gen(function* () {
		const config = yield* loadConfig;
		if (wantsJson()) {
			yield* emit({
				endpoint: config.endpoint,
				...(config.contentOrigin !== undefined
					? { contentOrigin: config.contentOrigin }
					: {}),
				authenticated: true,
				config: configPath()
			});
		} else {
			yield* Console.log(`Server      ${config.endpoint}`);
			yield* Console.log('Credential  accepted');
			yield* Console.log(`Config      ${configPath()}`);
		}
	})
).pipe(
	Command.withDescription('Show the configured server and credential state')
);
