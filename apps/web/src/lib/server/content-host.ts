import { Effect, Schema } from 'effect';
import { runWorkerProgram } from './edge';
import { StorageError } from './errors';
import { PgSql } from './pg';
import { AuthGuardStore } from './services/bindings';
import { SLUG_REDIRECT_WINDOW_MS } from './slug-policy';

// The org a content request is served for, as resolved from its host.
export interface ContentHost {
	readonly orgId: string;
	readonly slug: string;
}

export type ContentHostResolution =
	| { readonly _tag: 'Found'; readonly host: ContentHost }
	// A slug the org gave up within the redirect window: the hook answers
	// 301 to the same path on the org's current host.
	| { readonly _tag: 'Moved'; readonly slug: string }
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
	Schema.Struct({ movedTo: Schema.String }),
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
): ContentHostResolution => {
	if ('missing' in entry) return { _tag: 'Missing' };
	if ('movedTo' in entry) return { _tag: 'Moved', slug: entry.movedTo };
	return entry.trust === 'suspended'
		? { _tag: 'Missing' }
		: { _tag: 'Found', host: { orgId: entry.orgId, slug } };
};

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
	// The live slug wins; otherwise a slug the org released within the
	// redirect window points at its current one (a suspended org's old
	// slug still redirects, to a host that then answers 404).
	const redirectCutoff = new Date(
		Date.now() - SLUG_REDIRECT_WINDOW_MS
	).toISOString();
	const rows = yield* sql<{
		id: string | null;
		trust: string | null;
		moved_to: string | null;
	}>`
		SELECT id, trust, moved_to FROM (
			SELECT o.id, o.trust, NULL AS moved_to, 0 AS rank
			FROM orgs o WHERE o.slug = ${slug}
			UNION ALL
			SELECT NULL, NULL, o.slug, 1 AS rank
			FROM org_slug_history h
			JOIN orgs o ON o.id = h.org_id
			WHERE h.slug = ${slug} AND h.released_at > ${redirectCutoff}
		) candidates
		ORDER BY rank
		LIMIT 1
	`.pipe(
		Effect.mapError(
			(cause) => new StorageError({ operation: 'resolve org slug', cause })
		)
	);
	const row = rows[0];
	const entry: typeof CachedSlug.Type =
		row?.id !== null && row?.id !== undefined && row.trust !== null
			? { orgId: row.id, trust: row.trust }
			: row?.moved_to
				? { movedTo: row.moved_to }
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
