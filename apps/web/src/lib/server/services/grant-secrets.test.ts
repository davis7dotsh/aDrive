import { readFileSync } from 'node:fs';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { Effect, Layer } from 'effect';
import { describe, expect, it } from 'vitest';
import { verifyPrivateGrant } from '../private-grant';
import { Db } from './bindings';
import { GrantSecrets, GrantSecretsLive } from './grant-secrets';

const migration = readFileSync(
	new URL('../../../../migrations/0007_instance_secrets.sql', import.meta.url),
	'utf8'
);

const d1FromSqlite = (database: DatabaseSync) =>
	({
		prepare: (query: string) => {
			const makeStatement = (
				boundValues: ReadonlyArray<SQLInputValue> = []
			) => ({
				bind: (...values: ReadonlyArray<SQLInputValue>) =>
					makeStatement(values),
				run: async () => {
					await Promise.resolve();
					const result = database.prepare(query).run(...boundValues);
					return {
						success: true,
						results: [],
						meta: { changes: Number(result.changes) }
					};
				},
				first: async <T>() => {
					await Promise.resolve();
					return (
						(database.prepare(query).get(...boundValues) as T | undefined) ??
						null
					);
				}
			});
			return makeStatement();
		}
	}) as unknown as D1Database;

const requestLayer = (db: D1Database) =>
	GrantSecretsLive.pipe(Layer.provide(Layer.succeed(Db, db)));

const mintFromRequest = (
	db: D1Database,
	now = new Date('2026-07-27T12:00:00.000Z')
) =>
	Effect.runPromise(
		Effect.gen(function* () {
			const secrets = yield* GrantSecrets;
			return yield* secrets.mint({
				contentOrigin: 'https://content.example.test',
				fileId: 'file-1',
				version: 4,
				now
			});
		}).pipe(Effect.provide(requestLayer(db)))
	);

const verifyFromRequest = (
	db: D1Database,
	grant: Awaited<ReturnType<typeof mintFromRequest>>
) =>
	Effect.runPromise(
		Effect.gen(function* () {
			const secrets = yield* GrantSecrets;
			return yield* secrets.verify({
				contentOrigin: 'https://content.example.test',
				requestOrigin: 'https://content.example.test',
				fileId: 'file-1',
				version: 4,
				expiresAtSeconds: grant.expiresAtSeconds,
				signature: grant.signature,
				now: new Date('2026-07-27T12:00:00.000Z')
			});
		}).pipe(Effect.provide(requestLayer(db)))
	);

describe('persisted content grant secrets', () => {
	it('converges concurrent lazy initialization on one SQLite row', async () => {
		const database = new DatabaseSync(':memory:');
		database.exec(migration);
		const db = d1FromSqlite(database);

		const [left, right] = await Promise.all([
			mintFromRequest(db),
			mintFromRequest(db)
		]);
		const row = database
			.prepare('SELECT count(*) AS count FROM instance_secrets')
			.get() as { count: number };

		expect(row.count).toBe(1);
		await expect(verifyFromRequest(db, left)).resolves.toBe(true);
		await expect(verifyFromRequest(db, right)).resolves.toBe(true);
		database.close();
	});

	it('validates a link across separate request-scoped services', async () => {
		const database = new DatabaseSync(':memory:');
		database.exec(migration);
		const db = d1FromSqlite(database);

		const grant = await mintFromRequest(db);
		await expect(verifyFromRequest(db, grant)).resolves.toBe(true);
		await expect(verifyFromRequest(db, grant)).resolves.toBe(true);
		database.close();
	});

	it('caches the signing key per isolate within the TTL', async () => {
		const database = new DatabaseSync(':memory:');
		database.exec(migration);
		const db = d1FromSqlite(database);
		const prepared = db.prepare.bind(db);
		let secretReads = 0;
		db.prepare = (query: string) => {
			if (/FROM instance_secrets/.test(query)) secretReads += 1;
			return prepared(query);
		};

		await mintFromRequest(db);
		const readsAfterFirst = secretReads;
		await mintFromRequest(db);

		// The first request seeds and reads the key; the second reuses the
		// isolate cache instead of querying D1 again.
		expect(readsAfterFirst).toBeGreaterThan(0);
		expect(secretReads).toBe(readsAfterFirst);
		database.close();
	});

	it('does not let a raw PASSCODE guess validate a persisted-key grant', async () => {
		const database = new DatabaseSync(':memory:');
		database.exec(migration);
		const db = d1FromSqlite(database);
		const grant = await mintFromRequest(db);

		await expect(
			verifyPrivateGrant({
				signingKey: 'the guessed human PASSCODE',
				contentOrigin: 'https://content.example.test',
				requestOrigin: 'https://content.example.test',
				fileId: 'file-1',
				version: 4,
				expiresAtSeconds: grant.expiresAtSeconds,
				signature: grant.signature,
				now: new Date('2026-07-27T12:00:00.000Z')
			})
		).resolves.toBe(false);
		database.close();
	});
});
