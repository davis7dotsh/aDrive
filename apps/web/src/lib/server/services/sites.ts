import { Context, Effect, Layer } from 'effect';
import { AppConfig } from '../config';
import { PgSql } from '../pg';
import { Blobs } from './blobs';
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
	const sql = yield* PgSql;
	const blobs = yield* Blobs;
	const config = yield* AppConfig;

	const internals = createInternals({ sql, blobs, config });

	return Sites.of({
		...sessionOps(internals),
		...cleanupOps(internals),
		...readOps(internals)
	});
});

export const SitesLive = Layer.effect(Sites, makeSites);
