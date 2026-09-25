import { PgClient } from '@effect/sql-pg';
import { Context, Effect, Layer } from 'effect';
import { Reactivity } from 'effect/unstable/reactivity';
import Pg from 'pg';

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

// Distinct from SqlClient so Postgres and D1 can coexist in one request
// layer while the port is in progress. Services move over by yielding
// PgSql instead of SqlClient. Once D1 is gone this is the only client.
export class PgSql extends Context.Service<PgSql, PgClient.PgClient>()(
	'app/PgSql'
) {}

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
		PgClient.fromPool({ acquire, applicationName: 'adrive' })
	).pipe(Layer.provide(Reactivity.layer));
};
