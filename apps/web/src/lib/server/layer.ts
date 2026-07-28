import * as D1 from '@effect/sql-d1/D1Client';
import { Effect, Layer } from 'effect';
import { ConfigLive } from './config';
import { AuthLive } from './services/auth';
import { Db, Bucket } from './services/bindings';
import { BlobsLive } from './services/blobs';
import { FilesLive } from './services/files';
import { SearchLive } from './services/search';
import { SitesLive } from './services/sites';
import { TagsLive } from './services/tags';
import { SemanticBindingsLive } from './services/semantic';
import { IndexingLive } from './services/indexing';
import { LifecycleLive } from './services/lifecycle';
import { GrantSecretsLive } from './services/grant-secrets';

const SqlLive = Layer.unwrap(Effect.map(Db, (db) => D1.layer({ db })));

export const requestLayer = (env: Env) => {
	const bindings = Layer.mergeAll(
		Layer.succeed(Db, env.DB),
		Layer.succeed(Bucket, env.BUCKET),
		ConfigLive(env)
	);
	const sql = SqlLive.pipe(Layer.provide(bindings));
	const blobs = BlobsLive.pipe(Layer.provide(bindings));
	const infrastructure = Layer.mergeAll(bindings, sql, blobs);
	const semantic = SemanticBindingsLive(env);
	const auth = AuthLive.pipe(Layer.provide(infrastructure));
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
		grantSecrets,
		tags,
		search,
		sites,
		files,
		indexing,
		lifecycle
	);
};
