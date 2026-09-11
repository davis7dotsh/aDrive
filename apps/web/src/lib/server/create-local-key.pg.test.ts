import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Effect, Layer } from 'effect';
import Pg from 'pg';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { migrate } from '../../../scripts/pg-migrate.mjs';
import { pgLayer } from './pg';
import { Auth, AuthLive } from './services/auth';
import {
	anonymousOrg,
	anonymousUser,
	CurrentOrg,
	CurrentUser
} from './services/current-org';
import { FAKE_DEV_USER, fakeSession, WorkOSFake } from './services/workos';
import { TEST_DATABASE_URL } from './test/database';

const script = fileURLToPath(
	new URL('../../../../../scripts/create-local-key.mjs', import.meta.url)
);

const createContext = async () => {
	const schema = `local_key_test_${crypto.randomUUID().replaceAll('-', '')}`;
	const client = new Pg.Client({ connectionString: TEST_DATABASE_URL });
	await client.connect();
	await client.query(`CREATE SCHEMA ${schema}`);
	const close = async () => {
		try {
			await client.query(`DROP SCHEMA ${schema} CASCADE`);
		} finally {
			await client.end();
		}
	};
	try {
		await client.query(`SET search_path TO ${schema}, public`);
		const url = new URL(TEST_DATABASE_URL);
		url.searchParams.set('options', `-csearch_path=${schema},public`);
		await migrate({ url: url.href, log: () => undefined });
		const authLayer = AuthLive.pipe(
			Layer.provide(
				Layer.mergeAll(
					pgLayer({ connectionString: url.href }),
					WorkOSFake,
					Layer.succeed(CurrentOrg, anonymousOrg),
					Layer.succeed(CurrentUser, anonymousUser)
				)
			)
		);
		return {
			client,
			close,
			signIn: () =>
				Effect.runPromise(
					Effect.gen(function* () {
						const auth = yield* Auth;
						const { sealedSession } = yield* auth.completeSignIn(
							fakeSession(FAKE_DEV_USER)
						);
						const identity = yield* auth.resolveSession(sealedSession);
						return identity.auth?.orgId;
					}).pipe(Effect.provide(authLayer))
				),
			createKey: () =>
				new Promise<void>((resolve, reject) => {
					// execFile captures output. Never surface the generated key, including
					// through a child-process error object's stdout in test failures.
					execFile(
						'bun',
						[script],
						{
							env: { ...process.env, DATABASE_URL: url.href }
						},
						(error) => {
							if (error) reject(new Error('Local API key script failed'));
							else resolve();
						}
					);
				})
		};
	} catch (cause) {
		await close();
		throw cause;
	}
};

describe('local CLI and fake browser share one drive', () => {
	let context: Awaited<ReturnType<typeof createContext>>;
	beforeEach(async () => {
		context = await createContext();
	});
	afterEach(async () => {
		await context?.close();
	});

	it('creates the CLI key in the existing fake browser organization', async () => {
		const orgId = await context.signIn();
		expect(orgId?.startsWith('org_fake_')).toBe(true);
		await context.createKey();
		expect(
			(await context.client.query('SELECT org_id, user_id FROM api_keys')).rows
		).toEqual([{ org_id: orgId, user_id: FAKE_DEV_USER }]);
		expect((await context.client.query('SELECT id FROM orgs')).rows).toEqual([
			{ id: orgId }
		]);
	});

	it('reuses the CLI bootstrap organization when fake browser sign-in happens later', async () => {
		await context.createKey();
		const orgId = await context.signIn();
		expect(orgId).toBe('org_local');
		expect(
			(await context.client.query('SELECT org_id, user_id FROM api_keys')).rows
		).toEqual([{ org_id: orgId, user_id: FAKE_DEV_USER }]);
		expect(
			(await context.client.query('SELECT org_id, user_id FROM memberships'))
				.rows
		).toEqual([{ org_id: orgId, user_id: FAKE_DEV_USER }]);
		expect(
			(await context.client.query('SELECT org_id FROM org_usage')).rows
		).toEqual([{ org_id: orgId }]);
	});
});
