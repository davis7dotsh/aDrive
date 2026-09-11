import type { Tag, TagCreate, TagUpdate } from '@adrive/shared';
import { Context, Effect, Layer, Schema } from 'effect';
import { InvalidRequest, NotFound, StorageError, validate } from '../errors';
import { refreshAllIndexedTags, refreshSearchDocument } from '../search-index';
import {
	normalizeTagColor,
	normalizeTagName,
	uniqueTagNames
} from '../tag-policy';
import { createObjectTtlCache } from '../isolate-cache';
import { PgSql } from '../pg';

const TAG_LIST_CACHE_TTL_MS = 5_000;
// One database per deployment, so the per-isolate cache needs a single
// stable key; the Postgres client is rebuilt per request and cannot be it.
const tagListCacheKey = {};
const tagListCache = createObjectTtlCache<object, ReadonlyArray<Tag>>(
	TAG_LIST_CACHE_TTL_MS
);

export const forgetTagListCache = () => {
	tagListCache.delete(tagListCacheKey);
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
		COUNT(ft.file_id)::integer AS file_count,
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
	const sql = yield* PgSql;
	const select = sql.literal(tagSelect);

	const list = Effect.gen(function* () {
		const cached = tagListCache.get(tagListCacheKey);
		if (cached) return cached;
		const rows = yield* sql`
			${select}
			GROUP BY t.id
			ORDER BY t.normalized_name, t.id`.pipe(
			Effect.mapError(
				(cause) => new StorageError({ operation: 'list tags', cause })
			)
		);
		const tags = decodeTagRows(rows).map(toTag);
		tagListCache.set(tagListCacheKey, tags);
		return tags;
	}).pipe(Effect.withSpan('Tags.list'));

	const find = Effect.fn('Tags.find')(function* (id: string) {
		const rows = yield* sql`
			${select}
			WHERE t.id = ${id}
			GROUP BY t.id
			LIMIT 1`.pipe(
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
		const rows = yield* sql`
			${select}
			WHERE ${sql.in('t.normalized_name', normalizedNames)}
			GROUP BY t.id
			ORDER BY t.normalized_name`.pipe(
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
			yield* sql`
				INSERT INTO tags ${sql.insert(
					missing.map((tag) => ({
						id: crypto.randomUUID(),
						name: tag.name,
						normalized_name: tag.normalizedName,
						color: null,
						created_at: createdAt
					}))
				)}
				ON CONFLICT (normalized_name) DO NOTHING`.pipe(
				Effect.mapError(
					(cause) => new StorageError({ operation: 'auto-create tags', cause })
				)
			);
			forgetTagListCache();
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
			yield* sql`
				INSERT INTO tags (id, name, normalized_name, color, created_at)
				VALUES (
					${crypto.randomUUID()}, ${tag.name}, ${tag.normalizedName},
					${color}, ${createdAt}
				)
				ON CONFLICT (normalized_name) DO NOTHING`.pipe(
				Effect.mapError(
					(cause) => new StorageError({ operation: 'create tag', cause })
				)
			);
			const resolved = yield* findByNormalized([tag.normalizedName]);
			const result = resolved[0];
			if (!result) {
				return yield* new StorageError({
					operation: 'read created tag',
					cause: 'Tag was not returned after creation'
				});
			}
			forgetTagListCache();
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

			yield* sql
				.withTransaction(
					sql`
						UPDATE tags
						SET name = ${name.name}, normalized_name = ${name.normalizedName},
							color = ${color}
						WHERE id = ${id}`.pipe(Effect.andThen(refreshAllIndexedTags(sql)))
				)
				.pipe(
					Effect.mapError(
						(cause) => new StorageError({ operation: 'update tag', cause })
					)
				);
			forgetTagListCache();
			return yield* find(id);
		}),
		remove: Effect.fn('Tags.remove')(function* (id) {
			yield* find(id);
			// file_tags cascades from tags, so one delete drops the links.
			yield* sql
				.withTransaction(
					sql`DELETE FROM tags WHERE id = ${id}`.pipe(
						Effect.andThen(refreshAllIndexedTags(sql))
					)
				)
				.pipe(
					Effect.mapError(
						(cause) => new StorageError({ operation: 'delete tag', cause })
					)
				);
			forgetTagListCache();
		}),
		setFileTags: Effect.fn('Tags.setFileTags')(function* (fileId, names) {
			yield* sql
				.withTransaction(
					Effect.gen(function* () {
						// Replacements must serialize even when the file has no tags.
						// Locking only existing file_tags rows leaves that case unprotected.
						const file = yield* sql`
							SELECT id FROM files WHERE id = ${fileId} FOR UPDATE`;
						if (file.length === 0) return yield* new NotFound({ id: fileId });
						const resolved = yield* resolveNames(names);
						yield* sql`DELETE FROM file_tags WHERE file_id = ${fileId}`;
						if (resolved.length > 0) {
							yield* sql`
								INSERT INTO file_tags ${sql.insert(
									resolved.map((tag) => ({ file_id: fileId, tag_id: tag.id }))
								)}`;
						}
						yield* refreshSearchDocument(sql, fileId);
					})
				)
				.pipe(
					Effect.catchTag('SqlError', (cause) =>
						Effect.fail(new StorageError({ operation: 'set file tags', cause }))
					)
				);
			forgetTagListCache();
		})
	});
});

export const TagsLive = Layer.effect(Tags, makeTags);
