import { Effect, Layer } from 'effect';
import { ConfigLive } from './config';
import { AuthGuardLive } from './services/auth-guard';
import { AuthLive } from './services/auth';
import { AuthGuardStore, Bucket, Jobs, Pg } from './services/bindings';
import { pgLayer } from './pg';
import { BlobsLive } from './services/blobs';
import { FilesLive } from './services/files';
import { SearchLive } from './services/search';
import { SitesLive } from './services/sites';
import { TagsLive } from './services/tags';
import { SemanticBindingsLive } from './services/semantic';
import { IndexingLive } from './services/indexing';
import { LifecycleLive } from './services/lifecycle';
import { GrantSecretsLive } from './services/grant-secrets';
import { JobQueueLive } from './services/jobs';

export const PgLive = Layer.unwrap(
	Effect.map(Pg, (hyperdrive) => pgLayer(hyperdrive))
);

export const requestLayer = (env: Env) => {
	const bindings = Layer.mergeAll(
		Layer.succeed(Pg, env.HYPERDRIVE),
		Layer.succeed(Bucket, env.BUCKET),
		Layer.succeed(AuthGuardStore, env.AUTH_GUARD),
		Layer.succeed(Jobs, env.JOBS),
		ConfigLive(env)
	);
	const pg = PgLive.pipe(Layer.provide(bindings));
	const blobs = BlobsLive.pipe(Layer.provide(bindings));
	const jobQueue = JobQueueLive.pipe(Layer.provide(bindings));
	const infrastructure = Layer.mergeAll(bindings, pg, blobs, jobQueue);
	// The vector index reads and writes file_chunks, so it sits on Postgres
	// like every other service; only the embedder still binds Workers AI.
	const semantic = SemanticBindingsLive(env).pipe(
		Layer.provide(infrastructure)
	);
	const auth = AuthLive.pipe(Layer.provide(infrastructure));
	const authGuard = AuthGuardLive().pipe(Layer.provide(bindings));
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
		auth,
		authGuard,
		grantSecrets,
		tags,
		search,
		sites,
		files,
		indexing,
		lifecycle
	);
};
