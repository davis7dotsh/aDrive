import { Effect, Layer } from 'effect';
import { describe, expect, it } from 'vitest';
import { AppConfig, type AppConfigShape } from '../config';
import { PgSql } from '../pg';
import { verifyPrivateGrant } from '../private-grant';
import { testPgLayer } from '../test/pg';
import { CurrentOrg } from './current-org';
import { GrantSecrets, GrantSecretsLive } from './grant-secrets';

// Grants bind to the current org's content origin, so the service needs
// the org and the content domain it lives under.
const config: AppConfigShape = {
	dashboardOrigin: 'https://drive.example.test',
	contentDomain: 'content.example.test',
	contentScheme: 'https:',
	contentOriginFor: (slug) => `https://${slug}.content.example.test`,
	maxUploadBytes: 1,
	maintenanceSecret: 'test-maintenance-secret',
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
};

// The signing key is a per-instance singleton row (id = 1) in a shared test
// database, so these tests never assume the row is absent. They assert
// that mint and verify agree across request-scoped services and that the
// key is read from Postgres at most once per isolate within the TTL.
const requestLayer = (slug = 'org-test') =>
	GrantSecretsLive.pipe(
		Layer.provideMerge(
			Layer.mergeAll(
				testPgLayer(),
				Layer.succeed(AppConfig, config),
				Layer.succeed(CurrentOrg, { id: 'org_test', slug })
			)
		)
	);

const now = new Date('2026-07-27T12:00:00.000Z');

const mintFromRequest = (fileId: string) =>
	Effect.runPromise(
		Effect.gen(function* () {
			const secrets = yield* GrantSecrets;
			return yield* secrets.mint({
				orgId: 'org_test',
				fileId,
				version: 4,
				now
			});
		}).pipe(Effect.provide(requestLayer()))
	);

const verifyFromRequest = (
	fileId: string,
	grant: Awaited<ReturnType<typeof mintFromRequest>>,
	slug = 'org-test'
) =>
	Effect.runPromise(
		Effect.gen(function* () {
			const secrets = yield* GrantSecrets;
			return yield* secrets.verify({
				orgId: 'org_test',
				requestOrigin: `https://${slug}.content.example.test`,
				fileId,
				version: 4,
				expiresAtSeconds: grant.expiresAtSeconds,
				signature: grant.signature,
				now
			});
		}).pipe(Effect.provide(requestLayer(slug)))
	);

const readPersistedKey = () =>
	Effect.runPromise(
		Effect.gen(function* () {
			const sql = yield* PgSql;
			const rows = yield* sql<{ key: string; count: number }>`
				SELECT
					(SELECT content_grant_signing_key FROM instance_secrets WHERE id = 1) AS key,
					(SELECT count(*) FROM instance_secrets) AS count
			`;
			return rows[0];
		}).pipe(Effect.provide(testPgLayer()))
	);

describe('persisted content grant secrets', () => {
	it('converges concurrent lazy initialization on one Postgres row', async () => {
		const fileId = `grant-${crypto.randomUUID()}`;
		const [left, right] = await Promise.all([
			mintFromRequest(fileId),
			mintFromRequest(fileId)
		]);
		const persisted = await readPersistedKey();

		expect(persisted?.count).toBe(1);
		expect(persisted?.key).toMatch(/^[A-Za-z0-9_-]{43}$/);
		await expect(verifyFromRequest(fileId, left)).resolves.toBe(true);
		await expect(verifyFromRequest(fileId, right)).resolves.toBe(true);
	});

	it('validates a link across separate request-scoped services', async () => {
		const fileId = `grant-${crypto.randomUUID()}`;
		const grant = await mintFromRequest(fileId);
		await expect(verifyFromRequest(fileId, grant)).resolves.toBe(true);
		await expect(verifyFromRequest(fileId, grant)).resolves.toBe(true);
	});

	it('binds a grant to the org host it was minted for', async () => {
		const fileId = `grant-${crypto.randomUUID()}`;
		const grant = await mintFromRequest(fileId);
		// The same signing key on another org's host does not validate it.
		await expect(verifyFromRequest(fileId, grant, 'other-org')).resolves.toBe(
			false
		);
	});

	it('caches the signing key per isolate within the TTL', async () => {
		const fileId = `grant-${crypto.randomUUID()}`;
		// Warm the isolate cache, then swap the persisted key underneath it.
		// A cached isolate keeps signing with the key it already holds, so a
		// grant minted now still verifies against a fresh request-scoped
		// service even though the row no longer matches.
		const before = await mintFromRequest(fileId);
		const persisted = await readPersistedKey();
		const replacement = persisted?.key.endsWith('A')
			? `${persisted.key.slice(0, -1)}B`
			: `${persisted?.key.slice(0, -1)}A`;
		await Effect.runPromise(
			Effect.gen(function* () {
				const sql = yield* PgSql;
				yield* sql`
					UPDATE instance_secrets
					SET content_grant_signing_key = ${replacement}
					WHERE id = 1
				`;
			}).pipe(Effect.provide(testPgLayer()))
		);
		try {
			await expect(verifyFromRequest(fileId, before)).resolves.toBe(true);
			await expect(
				verifyPrivateGrant({
					signingKey: replacement,
					contentOrigin: 'https://content.example.test',
					orgId: 'org_test',
					requestOrigin: 'https://content.example.test',
					fileId,
					version: 4,
					expiresAtSeconds: before.expiresAtSeconds,
					signature: before.signature,
					now
				})
			).resolves.toBe(false);
		} finally {
			await Effect.runPromise(
				Effect.gen(function* () {
					const sql = yield* PgSql;
					yield* sql`
						UPDATE instance_secrets
						SET content_grant_signing_key = ${persisted?.key ?? replacement}
						WHERE id = 1
					`;
				}).pipe(Effect.provide(testPgLayer()))
			);
		}
	});

	it('does not let a raw PASSCODE guess validate a persisted-key grant', async () => {
		const fileId = `grant-${crypto.randomUUID()}`;
		const grant = await mintFromRequest(fileId);

		await expect(
			verifyPrivateGrant({
				signingKey: 'the guessed human PASSCODE',
				contentOrigin: 'https://content.example.test',
				orgId: 'org_test',
				requestOrigin: 'https://content.example.test',
				fileId,
				version: 4,
				expiresAtSeconds: grant.expiresAtSeconds,
				signature: grant.signature,
				now
			})
		).resolves.toBe(false);
	});
});
