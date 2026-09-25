import { Context } from 'effect';

export class Db extends Context.Service<Db, D1Database>()('app/Db') {}

// Hyperdrive binding. Only the connection string is used; the pool itself
// is built per request in pg.ts.
export class Pg extends Context.Service<Pg, Hyperdrive>()('app/Pg') {}

export class Bucket extends Context.Service<Bucket, R2Bucket>()('app/Bucket') {}

export interface AuthGuardStoreShape {
	readonly get: (key: string) => Promise<string | null>;
	readonly put: (
		key: string,
		value: string,
		options: { readonly expirationTtl: number }
	) => Promise<void>;
	readonly delete: (key: string) => Promise<void>;
}

export class AuthGuardStore extends Context.Service<
	AuthGuardStore,
	AuthGuardStoreShape
>()('app/AuthGuardStore') {}
