import { Context, Effect, Layer } from 'effect';
import { AppConfig } from '../config';
import { Blobs } from './blobs';
import { Db } from './bindings';
import { cleanupOps } from './sites/cleanup';
import { createInternals } from './sites/internals';
import { publishOps } from './sites/publish';
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
	const session = sessionOps(internals);

	return Sites.of({
		...session,
		...cleanupOps(internals),
		...readOps(internals),
		...publishOps(internals, session)
	});
});

export const SitesLive = Layer.effect(Sites, makeSites);
