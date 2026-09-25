import { Effect, Layer } from 'effect';
import { ConfigLive } from './config';
import { OrgMissing, StorageError } from './errors';
import type { ProgramTenant } from './identity';
import { PgSql } from './pg';
import { AuthGuardLive } from './services/auth-guard';
import { AuthLive } from './services/auth';
import { AuthGuardStore, Bucket, Jobs, Pg } from './services/bindings';
import { pgLayer } from './pg';
import { BlobsLive } from './services/blobs';
import {
	anonymousOrg,
	anonymousUser,
	CurrentOrg,
	CurrentUser
} from './services/current-org';
import { FilesLive } from './services/files';
import { SearchLive } from './services/search';
import { SitesLive } from './services/sites';
import { TagsLive } from './services/tags';
import { SemanticBindingsLive } from './services/semantic';
import { IndexingLive } from './services/indexing';
import { LifecycleLive } from './services/lifecycle';
import { GrantSecretsLive } from './services/grant-secrets';
import { JobQueueLive } from './services/jobs';
import { OrgLive } from './services/org';
import { WorkOSLive } from './services/workos';

export const PgLive = Layer.unwrap(
	Effect.map(Pg, (hyperdrive) => pgLayer(hyperdrive))
);

// The org for the program. A caller that already knows the slug (a
// request, a sweep) hands it over; one that only knows the id (a queued
// job) costs one lookup when the layer is built.
const currentOrgLayer = <E>(
	tenant: ProgramTenant | null,
	pg: Layer.Layer<PgSql, E>
) => {
	if (tenant === null) return Layer.succeed(CurrentOrg, anonymousOrg);
	if (tenant.orgSlug !== undefined) {
		return Layer.succeed(CurrentOrg, {
			id: tenant.orgId,
			slug: tenant.orgSlug
		});
	}
	const orgId = tenant.orgId;
	return Layer.effect(
		CurrentOrg,
		Effect.gen(function* () {
			const sql = yield* PgSql;
			const rows = yield* sql<{ slug: string }>`
				SELECT slug FROM orgs WHERE id = ${orgId} LIMIT 1
			`;
			const row = rows[0];
			if (!row) return yield* new OrgMissing({ orgId });
			return { id: orgId, slug: row.slug };
		}).pipe(
			Effect.catchTag(
				'SqlError',
				(cause) => new StorageError({ operation: 'resolve org slug', cause })
			)
		)
	).pipe(Layer.provide(pg));
};

// One layer per program, bound to one tenant. Services capture the org
// when they are built, so a sweep that visits several orgs builds one
// layer per org (cheap: the pool connects lazily) instead of threading
// the org through every call.
export const requestLayer = (env: Env, tenant: ProgramTenant | null) => {
	const platform = Layer.mergeAll(
		Layer.succeed(Pg, env.HYPERDRIVE),
		Layer.succeed(Bucket, env.BUCKET),
		Layer.succeed(AuthGuardStore, env.AUTH_GUARD),
		Layer.succeed(Jobs, env.JOBS),
		Layer.succeed(
			CurrentUser,
			tenant?.userId ? { id: tenant.userId } : anonymousUser
		),
		ConfigLive(env)
	);
	const pg = PgLive.pipe(Layer.provide(platform));
	const bindings = Layer.merge(platform, currentOrgLayer(tenant, pg));
	const blobs = BlobsLive.pipe(Layer.provide(bindings));
	const jobQueue = JobQueueLive.pipe(Layer.provide(bindings));
	const infrastructure = Layer.mergeAll(bindings, pg, blobs, jobQueue);
	// The vector index reads and writes file_chunks, so it sits on Postgres
	// like every other service; only the embedder still binds Workers AI.
	const semantic = SemanticBindingsLive(env).pipe(
		Layer.provide(infrastructure)
	);
	const workos = WorkOSLive.pipe(Layer.provide(bindings));
	const auth = AuthLive.pipe(
		Layer.provide(Layer.merge(infrastructure, workos))
	);
	const authGuard = AuthGuardLive().pipe(Layer.provide(bindings));
	const orgService = OrgLive.pipe(Layer.provide(infrastructure));
	const grantSecrets = GrantSecretsLive.pipe(Layer.provide(infrastructure));
	const tags = TagsLive.pipe(Layer.provide(infrastructure));
	const search = SearchLive.pipe(
		Layer.provide(Layer.merge(infrastructure, semantic))
	);
	const sites = SitesLive.pipe(Layer.provide(infrastructure));
	const files = FilesLive.pipe(
		Layer.provide(Layer.mergeAll(infrastructure, tags))
	);
	const indexing = IndexingLive.pipe(
		Layer.provide(Layer.mergeAll(infrastructure, semantic))
	);
	const lifecycle = LifecycleLive.pipe(
		Layer.provide(Layer.mergeAll(infrastructure, auth, sites, files, indexing))
	);

	return Layer.mergeAll(
		infrastructure,
		semantic,
		workos,
		auth,
		authGuard,
		orgService,
		grantSecrets,
		tags,
		search,
		sites,
		files,
		indexing,
		lifecycle
	);
};
