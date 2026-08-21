import { Context, Effect, Layer } from 'effect';
import { SqlClient } from 'effect/unstable/sql';
import { AppConfig } from '../config';
import { Blobs } from './blobs';
import { Db } from './bindings';
import { Tags } from './tags';
import { createInternals } from './files/internals';
import { mutationOps } from './files/mutations';
import { purgeOps } from './files/purge';
import { queryOps } from './files/queries';
import { thumbnailOps } from './files/thumbnails';
import { uploadOps } from './files/upload';
import type { FilesShape } from './files/types';

export type {
	DashboardThumbnailStoreResult,
	FileContent,
	FilesShape,
	ListPage,
	MutationResult,
	UploadResult
} from './files/types';
export type { UploadInput, VersionUploadInput } from './files/types';

export class Files extends Context.Service<Files, FilesShape>()('app/Files') {}

const makeFiles = Effect.gen(function* () {
	const db = yield* Db;
	const blobs = yield* Blobs;
	const sql = (yield* SqlClient.SqlClient).withoutTransforms();
	const config = yield* AppConfig;
	const tags = yield* Tags;
	const internals = createInternals({ db, blobs, sql, config, tags });

	return Files.of({
		...uploadOps(internals),
		...queryOps(internals),
		...mutationOps(internals),
		...purgeOps(internals),
		...thumbnailOps(internals)
	});
});

export const FilesLive = Layer.effect(Files, makeFiles);
