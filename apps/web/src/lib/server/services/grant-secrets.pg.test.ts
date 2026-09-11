import { Effect, Layer } from 'effect';
import { describe, expect, it } from 'vitest';
import { AppConfig, type AppConfigShape } from '../config';
import { PgSql } from '../pg';
import {
	PRIVATE_GRANT_TTL_SECONDS,
	verifyPrivateGrant
} from '../private-grant';
import { testPgLayer } from '../test/pg';
import { CurrentOrg } from './current-org';
import {
	GrantSecrets,
	GrantSecretsLive,
	type GrantSecretsShape
} from './grant-secrets';

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
const requestLayer = (slug = 'org-test', orgId = 'org_test') =>
	GrantSecretsLive.pipe(
		Layer.provideMerge(
			Layer.mergeAll(
				testPgLayer(),
				Layer.succeed(AppConfig, config),
				Layer.succeed(CurrentOrg, { id: orgId, slug })
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

const renamedGrant = async (purpose?: 'thumbnail-source') => {
	const id = crypto.randomUUID();
	const orgId = `grant-org-${id}`;
	const oldSlug = `before-${id.slice(0, 8)}`;
	const slug = `after-${id.slice(0, 8)}`;
	const fileId = `grant-file-${id}`;
	const grant = await Effect.runPromise(
		Effect.gen(function* () {
			const sql = yield* PgSql;
			yield* sql`INSERT INTO orgs (id, slug, name) VALUES (${orgId}, ${oldSlug}, 'Grant rename')`;
			const secrets = yield* GrantSecrets;
			const grant = yield* secrets.mint({
				orgId,
				fileId,
				version: 4,
				purpose,
				now
			});
			yield* sql.withTransaction(
				Effect.gen(function* () {
					yield* sql`UPDATE orgs SET slug = ${slug} WHERE id = ${orgId}`;
					yield* sql`
						INSERT INTO org_slug_history (slug, org_id, released_at)
						VALUES (${oldSlug}, ${orgId}, ${now.toISOString()})
					`;
				})
			);
			return grant;
		}).pipe(Effect.provide(requestLayer(oldSlug, orgId)))
	);
	const verify = (
		overrides: Partial<Parameters<GrantSecretsShape['verify']>[0]> = {}
	) =>
		Effect.runPromise(
			Effect.gen(function* () {
				const secrets = yield* GrantSecrets;
				return yield* secrets.verify({
					orgId,
					requestOrigin: config.contentOriginFor(slug),
					fileId,
					version: 4,
					...grant,
					purpose,
					now: new Date(now.getTime() + 60_000),
					...overrides
				});
			}).pipe(Effect.provide(requestLayer(slug, orgId)))
		);
	return { orgId, oldSlug, grant, verify };
};

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

	it.each([undefined, 'thumbnail-source'] as const)(
		'preserves an unexpired grant after the same org renames (purpose: %s)',
		async (purpose) => {
			const { verify } = await renamedGrant(purpose);
			await expect(verify()).resolves.toBe(true);
		}
	);

	it('keeps renamed grants bound to the current host, org, file, version, and purpose', async () => {
		const { oldSlug, verify } = await renamedGrant('thumbnail-source');
		for (const changed of [
			{ requestOrigin: config.contentOriginFor(oldSlug) },
			{ requestOrigin: config.contentOriginFor('unrelated-host') },
			{ orgId: 'unrelated-org' },
			{ fileId: 'unrelated-file' },
			{ version: 5 },
			{ purpose: undefined }
		]) {
			await expect(verify(changed)).resolves.toBe(false);
		}
		const ordinary = await renamedGrant();
		await expect(
			ordinary.verify({ purpose: 'thumbnail-source' })
		).resolves.toBe(false);
	});

	it('does not accept a historical origin belonging to a different org', async () => {
		const { oldSlug, verify } = await renamedGrant();
		const otherId = `grant-other-${crypto.randomUUID()}`;
		await Effect.runPromise(
			Effect.gen(function* () {
				const sql = yield* PgSql;
				yield* sql`INSERT INTO orgs (id, slug, name) VALUES (${otherId}, ${otherId}, 'Other grant org')`;
				yield* sql`UPDATE org_slug_history SET org_id = ${otherId} WHERE slug = ${oldSlug}`;
			}).pipe(Effect.provide(testPgLayer()))
		);
		await expect(verify()).resolves.toBe(false);
	});

	it('does not extend or allow changing a renamed grant expiration', async () => {
		const { grant, verify } = await renamedGrant();
		await expect(
			verify({ now: new Date((grant.expiresAtSeconds + 1) * 1_000) })
		).resolves.toBe(false);
		await expect(
			verify({ expiresAtSeconds: grant.expiresAtSeconds + 1 })
		).resolves.toBe(false);
	});

	it('ignores historical origins released more than a grant lifetime ago', async () => {
		const { oldSlug, verify } = await renamedGrant();
		const releasedAt = new Date(
			now.getTime() - (PRIVATE_GRANT_TTL_SECONDS + 1) * 1_000
		).toISOString();
		await Effect.runPromise(
			Effect.gen(function* () {
				const sql = yield* PgSql;
				yield* sql`UPDATE org_slug_history SET released_at = ${releasedAt} WHERE slug = ${oldSlug}`;
			}).pipe(Effect.provide(testPgLayer()))
		);
		await expect(verify()).resolves.toBe(false);
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
