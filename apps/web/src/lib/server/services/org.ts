import { Context, Effect, Layer, Schema } from 'effect';
import { SqlError } from 'effect/unstable/sql/SqlError';
import { AppConfig } from '../config';
import { forgetContentSlug } from '../content-host';
import { InvalidRequest, StorageError } from '../errors';
import { PgSql } from '../pg';
import {
	SLUG_REDIRECT_WINDOW_MS,
	nextSlugChangeAt,
	validateSlug
} from '../slug-policy';
import { AuthGuardStore } from './bindings';
import { CurrentOrg } from './current-org';

const OrgRow = Schema.Struct({
	id: Schema.String,
	slug: Schema.String,
	name: Schema.String,
	slug_changed_at: Schema.NullOr(Schema.String)
});

export interface OrgSettings {
	readonly id: string;
	readonly name: string;
	readonly slug: string;
	readonly contentOrigin: string;
	// When the slug may next change; null when it may now.
	readonly nextSlugChangeAt: string | null;
}

export interface OrgShape {
	readonly settings: Effect.Effect<OrgSettings, StorageError>;
	// Renames the org's content host. The old slug redirects to the new one
	// for 30 days and cannot be claimed meanwhile; both cache entries are
	// dropped so the change is live before they would have expired.
	readonly changeSlug: (
		slug: string
	) => Effect.Effect<OrgSettings, InvalidRequest | StorageError>;
}

export class Org extends Context.Service<Org, OrgShape>()('app/Org') {}

const makeOrg = Effect.gen(function* () {
	const sql = yield* PgSql;
	const config = yield* AppConfig;
	const org = yield* CurrentOrg;
	const store = yield* AuthGuardStore;

	const storageError = (operation: string) =>
		Effect.mapError((cause: unknown) => new StorageError({ operation, cause }));

	const toSettings = (row: typeof OrgRow.Type, now: Date): OrgSettings => ({
		id: row.id,
		name: row.name,
		slug: row.slug,
		contentOrigin: config.contentOriginFor(row.slug),
		nextSlugChangeAt: nextSlugChangeAt(row.slug_changed_at, now)
	});

	const load = Effect.gen(function* () {
		const rows = yield* sql`
			SELECT id, slug, name, slug_changed_at
			FROM orgs WHERE id = ${org.id}
		`.pipe(storageError('load org'));
		const decoded = Schema.decodeUnknownOption(OrgRow)(rows[0]);
		if (decoded._tag === 'None') {
			return yield* new StorageError({
				operation: 'load org',
				cause: 'The current org has no row'
			});
		}
		return decoded.value;
	});

	return Org.of({
		settings: Effect.map(load, (row) => toSettings(row, new Date())).pipe(
			Effect.withSpan('Org.settings')
		),
		changeSlug: Effect.fn('Org.changeSlug')(function* (input) {
			const validated = validateSlug(input);
			if (!validated.ok) {
				return yield* new InvalidRequest({
					status: 400,
					message: validated.message
				});
			}
			const now = new Date();
			const current = yield* load;
			if (validated.slug === current.slug) return toSettings(current, now);
			const allowedAt = nextSlugChangeAt(current.slug_changed_at, now);
			if (allowedAt !== null) {
				return yield* new InvalidRequest({
					status: 409,
					message: `The slug can change again on ${allowedAt.slice(0, 10)}`
				});
			}
			const redirectCutoff = new Date(
				now.getTime() - SLUG_REDIRECT_WINDOW_MS
			).toISOString();
			const nowIso = now.toISOString();
			// The update fails on the unique slug when another org owns the
			// name; a parked slug that still redirects is refused first unless
			// this org is the one that parked it (taking it back is fine).
			const changed = yield* sql
				.withTransaction(
					Effect.gen(function* () {
						const parked = yield* sql<{ org_id: string }>`
							SELECT org_id FROM org_slug_history
							WHERE slug = ${validated.slug} AND released_at > ${redirectCutoff}
							LIMIT 1
						`;
						const holder = parked[0];
						if (holder && holder.org_id !== org.id) return null;
						yield* sql`
							DELETE FROM org_slug_history
							WHERE slug = ${validated.slug}
								OR (org_id = ${org.id} AND released_at <= ${redirectCutoff})
						`;
						yield* sql`
							INSERT INTO org_slug_history (slug, org_id, released_at)
							VALUES (${current.slug}, ${org.id}, ${nowIso})
							ON CONFLICT (slug) DO UPDATE
							SET org_id = EXCLUDED.org_id, released_at = EXCLUDED.released_at
						`;
						const rows = yield* sql`
							UPDATE orgs
							SET slug = ${validated.slug}, slug_changed_at = ${nowIso}
							WHERE id = ${org.id} AND slug = ${current.slug}
							RETURNING id, slug, name, slug_changed_at
						`;
						return Schema.decodeUnknownOption(OrgRow)(rows[0]);
					})
				)
				.pipe(
					Effect.catchIf(
						(cause) =>
							cause instanceof SqlError &&
							cause.cause._tag === 'UniqueViolation',
						() => Effect.succeed(null)
					),
					storageError('change org slug')
				);
			if (changed === null || changed._tag === 'None') {
				return yield* new InvalidRequest({
					status: 409,
					message: 'That slug is taken'
				});
			}
			yield* Effect.all(
				[forgetContentSlug(current.slug), forgetContentSlug(validated.slug)],
				{ concurrency: 'unbounded' }
			).pipe(Effect.provideService(AuthGuardStore, store));
			// A session pins the slug it signed in with; it is refreshed on
			// the next request through the membership row, so no cookie work.
			return toSettings(changed.value, now);
		})
	});
});

export const OrgLive = Layer.effect(Org, makeOrg);
