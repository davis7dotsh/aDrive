import { Effect, Schema } from 'effect';
import { runWorkerProgram } from './edge';
import { StorageError } from './errors';
import { PgSql } from './pg';
import { AuthGuardStore } from './services/bindings';

// The org a content request is served for, as resolved from its host.
export interface ContentHost {
	readonly orgId: string;
	readonly slug: string;
}

export type ContentHostResolution =
	| { readonly _tag: 'Found'; readonly host: ContentHost }
	// Unknown slug, or an org that is suspended: every path is a 404.
	| { readonly _tag: 'Missing' };

// Slug lookups sit in front of every content request, so they are cached
// in the AUTH_GUARD KV namespace: `org-slug:<slug>` holds the org id and
// trust for five minutes; a miss is remembered for one minute so a burst
// of requests for a random host does not fan out to Postgres. Suspending
// an org or changing its slug must delete the key (forgetContentSlug) so
// the change lands before the entry expires.
export const contentSlugCacheKey = (slug: string) => `org-slug:${slug}`;
const CACHE_TTL_SECONDS = 300;
const NEGATIVE_CACHE_TTL_SECONDS = 60;

const CachedSlug = Schema.Union([
	Schema.Struct({ orgId: Schema.String, trust: Schema.String }),
	Schema.Struct({ missing: Schema.Literal(true) })
]);

const decodeCached = (value: string | null) => {
	if (value === null) return null;
	try {
		const decoded = Schema.decodeUnknownOption(CachedSlug)(JSON.parse(value));
		return decoded._tag === 'Some' ? decoded.value : null;
	} catch {
		return null;
	}
};

const resolution = (
	slug: string,
	entry: typeof CachedSlug.Type
): ContentHostResolution =>
	'missing' in entry || entry.trust === 'suspended'
		? { _tag: 'Missing' }
		: { _tag: 'Found', host: { orgId: entry.orgId, slug } };

export const resolveContentSlug = Effect.fn('resolveContentSlug')(function* (
	slug: string
) {
	const store = yield* AuthGuardStore;
	const sql = yield* PgSql;
	const key = contentSlugCacheKey(slug);
	const cached = decodeCached(
		yield* Effect.tryPromise({
			try: () => store.get(key),
			catch: (cause) =>
				new StorageError({ operation: 'read slug cache', cause })
		})
	);
	if (cached) return resolution(slug, cached);
	const rows = yield* sql<{ id: string; trust: string }>`
		SELECT id, trust FROM orgs WHERE slug = ${slug} LIMIT 1
	`.pipe(
		Effect.mapError(
			(cause) => new StorageError({ operation: 'resolve org slug', cause })
		)
	);
	const row = rows[0];
	const entry: typeof CachedSlug.Type = row
		? { orgId: row.id, trust: row.trust }
		: { missing: true };
	yield* Effect.tryPromise({
		try: () =>
			store.put(key, JSON.stringify(entry), {
				expirationTtl: row ? CACHE_TTL_SECONDS : NEGATIVE_CACHE_TTL_SECONDS
			}),
		catch: (cause) => new StorageError({ operation: 'write slug cache', cause })
	}).pipe(Effect.catchTag('StorageError', () => Effect.void));
	return resolution(slug, entry);
});

export const forgetContentSlug = (slug: string) =>
	Effect.flatMap(AuthGuardStore, (store) =>
		Effect.tryPromise({
			try: () => store.delete(contentSlugCacheKey(slug)),
			catch: (cause) =>
				new StorageError({ operation: 'purge slug cache', cause })
		})
	);

export const resolveContentHost = (env: Env, slug: string) =>
	runWorkerProgram(env, resolveContentSlug(slug));
