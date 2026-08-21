import * as NodeHttpClient from '@effect/platform-node/NodeHttpClient';
import * as NodeRuntime from '@effect/platform-node/NodeRuntime';
import * as NodeServices from '@effect/platform-node/NodeServices';
import { Effect } from 'effect';
import { Command, Flag } from 'effect/unstable/cli';
import { login, whoami } from './commands/auth.ts';
import { get, list, put, rename, status, tagSet } from './commands/files.ts';
import { site } from './commands/sites.ts';
import { tag } from './commands/tags.ts';
import { upgrade } from './commands/upgrade.ts';
import { findCliFailure, renderCliFailure } from './output.ts';
import { CLI_VERSION } from './version.ts';

const root = Command.make('adrive', {
	json: Flag.boolean('json').pipe(
		Flag.withDescription('Emit JSON lines on stdout (accepted anywhere)')
	)
}).pipe(
	Command.withDescription('A small CLI for an adrive deployment'),
	Command.withSubcommands([
		login,
		whoami,
		status,
		list,
		put,
		get,
		rename,
		site,
		tag,
		upgrade
	])
);

Command.run(root, { version: CLI_VERSION }).pipe(
	Effect.catchCause((cause) => {
		const failure = findCliFailure(cause);
		if (failure) {
			return Effect.sync(() => {
				renderCliFailure(failure);
				process.exit(1);
			});
		}
		return Effect.failCause(cause);
	}),
	Effect.provide([NodeServices.layer, NodeHttpClient.layerNodeHttp]),
	NodeRuntime.runMain
);
