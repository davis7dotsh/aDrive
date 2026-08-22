import { Context, Effect, Layer } from 'effect';
import { AppConfig } from '../config';
import { Blobs } from './blobs';
import { Db } from './bindings';
import { cleanupOps } from './sites/cleanup';
import { createInternals } from './sites/internals';
import { readOps } from './sites/read';
import { sessionOps } from './sites/sessions';
import type { SitesShape } from './sites/types';

export type {
	SiteSession,
	SiteCommitResult,
	SiteContent,
	SitesShape
} from './sites/types';

export class Sites extends Context.Service<Sites, SitesShape>()('app/Sites') {}

const makeSites = Effect.gen(function* () {
	const db = yield* Db;
	const blobs = yield* Blobs;
	const config = yield* AppConfig;

	const internals = createInternals({ db, blobs, config });

	return Sites.of({
		...sessionOps(internals),
		...cleanupOps(internals),
		...readOps(internals)
	});
});

export const SitesLive = Layer.effect(Sites, makeSites);
