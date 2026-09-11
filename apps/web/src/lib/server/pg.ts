import { PgClient } from '@effect/sql-pg';
import { Context, Effect, Layer } from 'effect';
import { Reactivity } from 'effect/unstable/reactivity';
import Pg from 'pg';
import { CurrentOrg, tenantOrgId } from './services/current-org';

// Postgres wire types come back as strings by default. The app stores
// timestamps as ISO strings and compares them lexically, and treats every
// integer-ish column as a JavaScript number, so decode both here once
// instead of at every call site.
const TIMESTAMPTZ = 1184;
const TIMESTAMP = 1114;
const INT8 = 20;
const NUMERIC = 1700;

const isoTimestamp = (value: string) => new Date(value).toISOString();
const safeNumber = (value: string) => {
	const parsed = Number(value);
	if (!Number.isSafeInteger(parsed) && Number.isInteger(parsed)) {
		throw new Error(`Postgres integer ${value} exceeds the safe range`);
	}
	return parsed;
};

const typeParsers: Pg.CustomTypesConfig = {
	getTypeParser: (oid, format) => {
		if (oid === TIMESTAMPTZ || oid === TIMESTAMP) return isoTimestamp;
		if (oid === INT8 || oid === NUMERIC) return safeNumber;
		return Pg.types.getTypeParser(oid as never, format as never);
	}
};

export interface PgConnection {
	readonly connectionString: string;
}

// The only SQL client. Every service yields it.
export class PgSql extends Context.Service<PgSql, PgClient.PgClient>()(
	'app/PgSql'
) {}

// Row level security keys on the transaction-local `app.current_org`
// setting. When a CurrentOrg is in context, every transaction pins it
// right after BEGIN so the policies in 0004_tenancy.sql refuse rows from
// other orgs even if a query forgets its predicate. Plain statements
// outside a transaction do not pin (Hyperdrive pools per transaction, so
// a session-level setting could leak between requests); they rely on
// their own `org_id = $1` clause, which every scoped query carries.
const orgPinned = (base: PgClient.PgClient): PgClient.PgClient => {
	const withTransaction = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
		base.withTransaction(
			Effect.flatMap(Effect.serviceOption(CurrentOrg), (org) => {
				const orgId = org._tag === 'Some' ? tenantOrgId(org.value) : null;
				return orgId === null
					? effect
					: base`SELECT set_config('app.current_org', ${orgId}, true)`.pipe(
							Effect.andThen(effect)
						);
			})
		);
	return new Proxy(base, {
		get: (target, property, receiver) =>
			property === 'withTransaction'
				? withTransaction
				: Reflect.get(target, property, receiver)
	});
};

// Hyperdrive hands each request a connection string for its pooler, so the
// pool lives for the request layer only. Hyperdrive already multiplexes
// real connections, so a small local pool is enough.
export const pgLayer = (connection: PgConnection) => {
	const acquire = Effect.acquireRelease(
		Effect.sync(() => {
			const pool = new Pg.Pool({
				connectionString: connection.connectionString,
				max: 4,
				types: typeParsers
			});
			// pg-pool removes failed idle connections before emitting this event.
			// Active query failures still flow through PgClient's typed errors.
			pool.on('error', () => undefined);
			return pool;
		}),
		(pool) => Effect.promise(() => pool.end())
	);
	return Layer.effect(
		PgSql,
		Effect.map(
			PgClient.fromPool({ acquire, applicationName: 'adrive' }),
			orgPinned
		)
	).pipe(Layer.provide(Reactivity.layer));
};
