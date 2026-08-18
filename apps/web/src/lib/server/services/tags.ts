import type { Tag, TagCreate, TagUpdate } from '@adrive/shared';
import { Context, Effect, Layer, Schema } from 'effect';
import { SqlClient } from 'effect/unstable/sql';
import { InvalidRequest, NotFound, StorageError, validate } from '../errors';
import {
	fileIndexStatements,
	refreshAllIndexedTagsStatement
} from '../search-index';
import {
	normalizeTagColor,
	normalizeTagName,
	uniqueTagNames
} from '../tag-policy';
import { createObjectTtlCache } from '../isolate-cache';
import { Db } from './bindings';

const TAG_LIST_CACHE_TTL_MS = 5_000;
const tagListCache = createObjectTtlCache<D1Database, ReadonlyArray<Tag>>(
	TAG_LIST_CACHE_TTL_MS
);

export const forgetTagListCache = (db: D1Database) => {
	tagListCache.delete(db);
};

const TagRow = Schema.Struct({
	id: Schema.String,
	name: Schema.String,
	normalized_name: Schema.String,
	color: Schema.NullOr(Schema.String),
	file_count: Schema.Int,
	created_at: Schema.String
});

const decodeTagRows = (rows: unknown) => {
	const decoded = Schema.decodeUnknownOption(Schema.Array(TagRow))(rows);
	return decoded._tag === 'Some' ? decoded.value : [];
};

const toTag = (row: typeof TagRow.Type): Tag => ({
	id: row.id,
	name: row.name,
	normalizedName: row.normalized_name,
	color: row.color,
	fileCount: row.file_count,
	createdAt: row.created_at
});

const tagSelect = `
	SELECT
		t.id,
		t.name,
		t.normalized_name,
		t.color,
		COUNT(ft.file_id) AS file_count,
		t.created_at
	FROM tags t
	LEFT JOIN file_tags ft ON ft.tag_id = t.id
`;

export interface TagsShape {
	readonly list: Effect.Effect<ReadonlyArray<Tag>, StorageError>;
	readonly create: (
		input: TagCreate
	) => Effect.Effect<Tag, InvalidRequest | StorageError>;
	readonly update: (
		id: string,
		input: TagUpdate
	) => Effect.Effect<Tag, InvalidRequest | NotFound | StorageError>;
	readonly remove: (id: string) => Effect.Effect<void, NotFound | StorageError>;
	readonly resolveNames: (
		names: ReadonlyArray<string>
	) => Effect.Effect<ReadonlyArray<Tag>, InvalidRequest | StorageError>;
	readonly setFileTags: (
		fileId: string,
		names: ReadonlyArray<string>
	) => Effect.Effect<void, InvalidRequest | NotFound | StorageError>;
}

export class Tags extends Context.Service<Tags, TagsShape>()('app/Tags') {}

const makeTags = Effect.gen(function* () {
	const db = yield* Db;
	const sql = (yield* SqlClient.SqlClient).withoutTransforms();

	const list = Effect.gen(function* () {
		const cached = tagListCache.get(db);
		if (cached) return cached;
		const rows = yield* sql
			.unsafe(
				`${tagSelect}
			GROUP BY t.id
			ORDER BY t.normalized_name, t.id`
			)
			.pipe(
				Effect.mapError(
					(cause) => new StorageError({ operation: 'list tags', cause })
				)
			);
		const tags = decodeTagRows(rows).map(toTag);
		tagListCache.set(db, tags);
		return tags;
	}).pipe(Effect.withSpan('Tags.list'));

	const find = Effect.fn('Tags.find')(function* (id: string) {
		const rows = yield* sql
			.unsafe(
				`${tagSelect}
				WHERE t.id = ?
				GROUP BY t.id
				LIMIT 1`,
				[id]
			)
			.pipe(
				Effect.mapError(
					(cause) => new StorageError({ operation: 'find tag', cause })
				)
			);
		const tag = decodeTagRows(rows)[0];
		if (!tag) return yield* new NotFound({ id });
		return toTag(tag);
	});

	const findByNormalized = Effect.fn('Tags.findByNormalized')(function* (
		normalizedNames: ReadonlyArray<string>
	) {
		if (normalizedNames.length === 0) return [];
		const placeholders = normalizedNames.map(() => '?').join(', ');
		const rows = yield* sql
			.unsafe(
				`${tagSelect}
				WHERE t.normalized_name IN (${placeholders})
				GROUP BY t.id
				ORDER BY t.normalized_name`,
				normalizedNames
			)
			.pipe(
				Effect.mapError(
					(cause) => new StorageError({ operation: 'resolve tag names', cause })
				)
			);
		return decodeTagRows(rows).map(toTag);
	});

	const resolveNames = Effect.fn('Tags.resolveNames')(function* (
		inputNames: ReadonlyArray<string>
	) {
		const names = uniqueTagNames(inputNames);
		const normalizedNames = yield* validate(() => names.map(normalizeTagName));
		const normalized = normalizedNames.map((tag) => tag.normalizedName);
		const existing = yield* findByNormalized(normalized);
		const existingNames = new Set(existing.map((tag) => tag.normalizedName));
		const createdAt = new Date().toISOString();
		const missing = normalizedNames.filter(
			(tag) => !existingNames.has(tag.normalizedName)
		);
		if (missing.length > 0) {
			yield* Effect.tryPromise({
				try: () =>
					db.batch(
						missing.map((tag) =>
							db
								.prepare(
									`INSERT INTO tags (
										id, name, normalized_name, color, created_at
									) VALUES (?, ?, ?, NULL, ?)
									ON CONFLICT(normalized_name) DO NOTHING`
								)
								.bind(
									crypto.randomUUID(),
									tag.name,
									tag.normalizedName,
									createdAt
								)
						)
					),
				catch: (cause) =>
					new StorageError({ operation: 'auto-create tags', cause })
			});
			forgetTagListCache(db);
		}
		const resolved = yield* findByNormalized(normalized);
		const byNormalized = new Map(
			resolved.map((tag) => [tag.normalizedName, tag])
		);
		return normalized.flatMap((name) => {
			const tag = byNormalized.get(name);
			return tag ? [tag] : [];
		});
	});

	return Tags.of({
		list,
		resolveNames,
		create: Effect.fn('Tags.create')(function* (input) {
			const tag = yield* validate(() => normalizeTagName(input.name));
			const color = yield* validate(() => normalizeTagColor(input.color));
			const createdAt = new Date().toISOString();
			yield* Effect.tryPromise({
				try: () =>
					db
						.prepare(
							`INSERT INTO tags (id, name, normalized_name, color, created_at)
							VALUES (?, ?, ?, ?, ?)
							ON CONFLICT(normalized_name) DO NOTHING`
						)
						.bind(
							crypto.randomUUID(),
							tag.name,
							tag.normalizedName,
							color,
							createdAt
						)
						.run(),
				catch: (cause) => new StorageError({ operation: 'create tag', cause })
			});
			const resolved = yield* findByNormalized([tag.normalizedName]);
			const result = resolved[0];
			if (!result) {
				return yield* new StorageError({
					operation: 'read created tag',
					cause: 'Tag was not returned after creation'
				});
			}
			forgetTagListCache(db);
			return result;
		}),
		update: Effect.fn('Tags.update')(function* (id, input) {
			const current = yield* find(id);
			const nextName = input.name;
			const name =
				nextName === undefined
					? {
							name: current.name,
							normalizedName: current.normalizedName
						}
					: yield* validate(() => normalizeTagName(nextName));
			const nextColor = input.color;
			const color =
				nextColor === undefined
					? current.color
					: yield* validate(() => normalizeTagColor(nextColor));
			const collision = (yield* findByNormalized([name.normalizedName])).find(
				(tag) => tag.id !== id
			);
			if (collision) {
				return yield* new InvalidRequest({
					status: 400,
					message: 'A tag with that name already exists'
				});
			}

			yield* Effect.tryPromise({
				try: () =>
					db.batch([
						db
							.prepare(
								`UPDATE tags
								SET name = ?, normalized_name = ?, color = ?
								WHERE id = ?`
							)
							.bind(name.name, name.normalizedName, color, id),
						refreshAllIndexedTagsStatement(db)
					]),
				catch: (cause) => new StorageError({ operation: 'update tag', cause })
			});
			forgetTagListCache(db);
			return yield* find(id);
		}),
		remove: Effect.fn('Tags.remove')(function* (id) {
			yield* find(id);
			yield* Effect.tryPromise({
				try: () =>
					db.batch([
						db.prepare('DELETE FROM file_tags WHERE tag_id = ?').bind(id),
						db.prepare('DELETE FROM tags WHERE id = ?').bind(id),
						refreshAllIndexedTagsStatement(db)
					]),
				catch: (cause) => new StorageError({ operation: 'delete tag', cause })
			});
			forgetTagListCache(db);
		}),
		setFileTags: Effect.fn('Tags.setFileTags')(function* (fileId, names) {
			const file = yield* sql
				.unsafe('SELECT id FROM files WHERE id = ? LIMIT 1', [fileId])
				.pipe(
					Effect.mapError(
						(cause) =>
							new StorageError({ operation: 'find tagged file', cause })
					)
				);
			if (file.length === 0) return yield* new NotFound({ id: fileId });
			const resolved = yield* resolveNames(names);
			const statements = [
				db.prepare('DELETE FROM file_tags WHERE file_id = ?').bind(fileId),
				...resolved.map((tag) =>
					db
						.prepare(
							`INSERT INTO file_tags (file_id, tag_id)
							VALUES (?, ?)`
						)
						.bind(fileId, tag.id)
				),
				...fileIndexStatements(db, fileId)
			];
			yield* Effect.tryPromise({
				try: () => db.batch(statements),
				catch: (cause) =>
					new StorageError({ operation: 'set file tags', cause })
			});
			forgetTagListCache(db);
		})
	});
});

export const TagsLive = Layer.effect(Tags, makeTags);
