import * as D1 from '@effect/sql-d1/D1Client';
import { Effect, Layer } from 'effect';
import { ConfigLive } from './config';
import { AuthLive } from './services/auth';
import { Db, Bucket } from './services/bindings';
import { BlobsLive } from './services/blobs';
import { FilesLive } from './services/files';

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
	const auth = AuthLive.pipe(Layer.provide(infrastructure));
	const files = FilesLive.pipe(Layer.provide(infrastructure));

	return Layer.mergeAll(infrastructure, auth, files);
};
