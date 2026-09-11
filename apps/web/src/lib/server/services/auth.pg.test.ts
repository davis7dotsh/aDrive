import { Effect, Layer } from 'effect';
import Pg from 'pg';
import { expect, it } from 'vitest';
import { AppConfig } from '../config';
import { PgSql, pgLayer } from '../pg';
import { ensureTestOrg, TEST_ORG_ID, TEST_USER_ID } from '../test/org';
import { CurrentOrg, CurrentUser } from './current-org';
import { WorkOSFake } from './workos';
import { TEST_DATABASE_URL } from '../test/database';
import { Auth, AuthLive } from './auth';

it('mints only one API key when approved device polls overlap', async () => {
	const suffix = crypto.randomUUID().replaceAll('-', '');
	const name = `device-race-${suffix}`;
	const functionName = `pause_device_key_${suffix}`;
	const triggerName = `pause_device_key_${suffix}`;
	const lockId = crypto.getRandomValues(new Int32Array(1))[0]!;
	const url = new URL(TEST_DATABASE_URL);
	url.searchParams.set('application_name', name);
	const databaseLayer = pgLayer({ connectionString: url.href });
	await Effect.runPromise(
		Effect.flatMap(PgSql, ensureTestOrg).pipe(Effect.provide(databaseLayer))
	);
	const authLayer = AuthLive.pipe(
		Layer.provide(
			Layer.mergeAll(
				databaseLayer,
				Layer.succeed(CurrentOrg, { id: TEST_ORG_ID }),
				Layer.succeed(CurrentUser, { id: TEST_USER_ID }),
				WorkOSFake,
				Layer.succeed(AppConfig, {
					dashboardOrigin: 'http://localhost:5173',
					contentOrigin: 'http://localhost:5174',
					maxUploadBytes: 1_000_000,
					maintenanceSecret: 'device-race-test-secret',
					workos: {
						apiKey: null,
						clientId: '',
						cookiePassword: '',
						webhookSecret: ''
					},
					semanticSearch: 'off',
					embeddingModel: '@cf/baai/bge-small-en-v1.5',
					embeddingPooling: 'cls',
					embeddingDimensions: 384
				})
			)
		)
	);
	const run = <A, E>(effect: Effect.Effect<A, E, Auth>) =>
		Effect.runPromise(effect.pipe(Effect.provide(authLayer)));
	const device = await run(
		Effect.gen(function* () {
			const auth = yield* Auth;
			const device = yield* auth.createDeviceAuthorization(name);
			yield* auth.approveDevice(device.userCode);
			return device;
		})
	);
	const poll = () =>
		run(
			Effect.flatMap(Auth, (auth) => auth.pollDevice(device.deviceCode)).pipe(
				Effect.catchTag('Unauthorized', () =>
					Effect.succeed({ status: 'unauthorized' as const })
				)
			)
		);
	const polls: ReturnType<typeof poll>[] = [];
	const control = new Pg.Client({ connectionString: TEST_DATABASE_URL });
	await control.connect();
	try {
		// Pause the first insert before its transaction can consume the code.
		// The previous implementation let a second INSERT observe the same
		// approval here, committing an orphan key when its consume lost.
		await control.query(`
			CREATE FUNCTION ${functionName}() RETURNS trigger LANGUAGE plpgsql AS $$
			BEGIN
				PERFORM pg_advisory_xact_lock(${lockId});
				RETURN NEW;
			END
			$$;
			CREATE TRIGGER ${triggerName} BEFORE INSERT ON api_keys
			FOR EACH ROW WHEN (NEW.name = '${name}')
			EXECUTE FUNCTION ${functionName}();
		`);
		await control.query('SELECT pg_advisory_lock($1)', [lockId]);
		const waitForBlockedPolls = (count: number) =>
			expect
				.poll(
					async () =>
						(
							await control.query(
								`SELECT pid FROM pg_stat_activity
								WHERE datname = current_database() AND application_name = $1
								AND wait_event_type = 'Lock'`,
								[name]
							)
						).rowCount,
					{ timeout: 5_000, interval: 10 }
				)
				.toBe(count);

		polls.push(poll());
		await waitForBlockedPolls(1);
		polls.push(poll());
		await waitForBlockedPolls(2);
		await control.query('SELECT pg_advisory_unlock($1)', [lockId]);

		const [first, second] = await Promise.all(polls);
		expect(first?.status).toBe('complete');
		expect(second?.status).toBe('unauthorized');
		const { rows: keys } = await control.query<{ id: string }>(
			'SELECT id FROM api_keys WHERE name = $1',
			[name]
		);
		expect(keys).toHaveLength(1);
		const { rows: codes } = await control.query(
			'SELECT status, api_key_id FROM device_codes WHERE name = $1',
			[name]
		);
		expect(codes).toEqual([{ status: 'consumed', api_key_id: keys[0]?.id }]);
		if (first?.status === 'complete') {
			const credential = await run(
				Effect.flatMap(Auth, (auth) => auth.resolveApiKey(first.apiKey))
			);
			expect(credential?.credentialId).toBe(keys[0]?.id);
		}
	} finally {
		await control.query('SELECT pg_advisory_unlock($1)', [lockId]);
		await Promise.allSettled(polls);
		try {
			await control.query(`DROP TRIGGER IF EXISTS ${triggerName} ON api_keys`);
			await control.query(`DROP FUNCTION IF EXISTS ${functionName}()`);
			await control.query('DELETE FROM device_codes WHERE name = $1', [name]);
			await control.query('DELETE FROM api_keys WHERE name = $1', [name]);
		} finally {
			await control.end();
		}
	}
});
