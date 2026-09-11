import { Cause, Effect, Exit, Layer } from 'effect';
import Pg from 'pg';
import { describe, expect, it, vi } from 'vitest';
import { AppConfig } from '../config';
import { pgLayer } from '../pg';
import { TEST_DATABASE_URL } from '../test/database';
import { AuthGuardStore } from './bindings';
import { CurrentOrg } from './current-org';
import { Org, OrgLive } from './org';

const config = AppConfig.of({
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
});

const createContext = async () => {
	const suffix = crypto.randomUUID().replaceAll('-', '').slice(0, 16);
	const control = new Pg.Client({ connectionString: TEST_DATABASE_URL });
	await control.connect();
	const deleted: string[] = [];
	const tenants = [
		{ id: `org_slug_a_${suffix}`, slug: `alpha-${suffix}` },
		{ id: `org_slug_b_${suffix}`, slug: `beta-${suffix}` }
	] as const;
	const changeSlug = (
		tenant: (typeof tenants)[number],
		slug: string,
		name: string
	) => {
		const url = new URL(TEST_DATABASE_URL);
		url.searchParams.set('application_name', `${name}-${suffix}`);
		const layer = OrgLive.pipe(
			Layer.provide(
				Layer.mergeAll(
					pgLayer({ connectionString: url.href }),
					Layer.succeed(AppConfig, config),
					Layer.succeed(CurrentOrg, tenant),
					Layer.succeed(AuthGuardStore, {
						get: async () => null,
						put: async () => undefined,
						delete: async (key) => {
							deleted.push(key);
						}
					})
				)
			)
		);
		return Effect.runPromiseExit(
			Effect.flatMap(Org, (org) => org.changeSlug(slug)).pipe(
				Effect.provide(layer)
			)
		);
	};
	const operations: ReturnType<typeof changeSlug>[] = [];
	const waitForQuery = (name: string, query: string) =>
		vi.waitFor(
			async () => {
				await control.query('SELECT pg_stat_clear_snapshot()');
				const { rows } = await control.query(
					`SELECT pid FROM pg_stat_activity
				WHERE datname = current_database() AND application_name = $1
				AND wait_event_type = 'Lock' AND query LIKE $2`,
					[`${name}-${suffix}`, `%${query}%`]
				);
				expect(rows).toHaveLength(1);
			},
			{ timeout: 5_000, interval: 10 }
		);
	return {
		control,
		deleted,
		suffix,
		tenants,
		waitForQuery,
		start: (...args: Parameters<typeof changeSlug>) => {
			const operation = changeSlug(...args);
			operations.push(operation);
			return operation;
		},
		seed: async () => {
			for (const tenant of tenants) {
				await control.query(
					'INSERT INTO orgs (id, slug, name) VALUES ($1, $2, $2)',
					[tenant.id, tenant.slug]
				);
			}
		},
		close: async () => {
			try {
				await control.query('ROLLBACK');
				await Promise.all(operations);
				await control.query('DELETE FROM orgs WHERE id = ANY($1::text[])', [
					tenants.map((tenant) => tenant.id)
				]);
			} finally {
				await control.end();
			}
		}
	};
};

describe('organization slug transactions', () => {
	it.each([false, true])(
		'serializes a waiting rename and rechecks reservations or cooldown (same org: %s)',
		async (sameOrg) => {
			const ctx = await createContext();
			const [a, b] = ctx.tenants;
			const newSlug = `changed-${ctx.suffix}`;
			try {
				await ctx.seed();
				// Hold A's row so its real rename is paused after acquiring the
				// namespace lock, before committing its new slug and history.
				await ctx.control.query('BEGIN');
				await ctx.control.query(
					'SELECT id FROM orgs WHERE id = $1 FOR UPDATE',
					[a.id]
				);
				const first = ctx.start(a, newSlug, 'first');
				await ctx.waitForQuery('first', 'UPDATE orgs');
				const second = ctx.start(
					sameOrg ? a : b,
					sameOrg ? `second-${ctx.suffix}` : a.slug,
					'second'
				);
				// The second request must wait before reading cooldown/history,
				// including when it targets a different organization.
				await ctx.waitForQuery('second', 'pg_advisory_xact_lock');
				await ctx.control.query('COMMIT');
				const [changed, rejected] = await Promise.all([first, second]);
				expect(
					Exit.isSuccess(changed),
					Exit.isFailure(changed) ? Cause.pretty(changed.cause) : undefined
				).toBe(true);
				expect(Exit.isFailure(rejected)).toBe(true);
				if (Exit.isFailure(rejected)) {
					expect(rejected.cause.reasons).toContainEqual(
						expect.objectContaining({
							_tag: 'Fail',
							error: expect.objectContaining({
								_tag: 'InvalidRequest',
								status: 409,
								message: sameOrg
									? expect.stringContaining('The slug can change again on')
									: 'That slug is taken'
							})
						})
					);
				}
				expect(
					(
						await ctx.control.query(
							'SELECT id, slug FROM orgs WHERE id = ANY($1::text[]) ORDER BY id',
							[[a.id, b.id]]
						)
					).rows
				).toEqual([{ id: a.id, slug: newSlug }, b]);
				expect(
					(
						await ctx.control.query(
							'SELECT slug, org_id FROM org_slug_history WHERE org_id = ANY($1::text[])',
							[[a.id, b.id]]
						)
					).rows
				).toEqual([{ slug: a.slug, org_id: a.id }]);
				expect(ctx.deleted.sort()).toEqual(
					[`org-slug:${a.slug}`, `org-slug:${newSlug}`].sort()
				);
			} finally {
				await ctx.close();
			}
		}
	);

	it('preserves all history when an outside writer makes the conditional update lose', async () => {
		const ctx = await createContext();
		const [a] = ctx.tenants;
		const target = `target-${ctx.suffix}`;
		const expired = `expired-${ctx.suffix}`;
		const external = `external-${ctx.suffix}`;
		try {
			await ctx.seed();
			await ctx.control.query(
				`INSERT INTO org_slug_history (slug, org_id, released_at)
				VALUES ($1, $3, now() - interval '1 day'), ($2, $3, now() - interval '31 days')`,
				[target, expired, a.id]
			);
			const before = (
				await ctx.control.query(
					'SELECT slug, org_id, released_at FROM org_slug_history WHERE org_id = $1 ORDER BY slug',
					[a.id]
				)
			).rows;
			await ctx.control.query('BEGIN');
			await ctx.control.query('UPDATE orgs SET slug = $1 WHERE id = $2', [
				external,
				a.id
			]);
			// The service sees A's committed old slug, then waits on the row.
			// Committing the outside change makes its WHERE slug = old fail.
			const operation = ctx.start(a, target, 'conditional');
			await ctx.waitForQuery('conditional', 'UPDATE orgs');
			await ctx.control.query('COMMIT');
			const result = await operation;
			expect(Exit.isFailure(result)).toBe(true);
			if (Exit.isFailure(result)) {
				expect(Cause.pretty(result.cause)).toContain(
					'The organization changed; try again'
				);
			}
			expect(
				(
					await ctx.control.query(
						'SELECT slug, org_id, released_at FROM org_slug_history WHERE org_id = $1 ORDER BY slug',
						[a.id]
					)
				).rows
			).toEqual(before);
			expect(
				(await ctx.control.query('SELECT slug FROM orgs WHERE id = $1', [a.id]))
					.rows
			).toEqual([{ slug: external }]);
			expect(ctx.deleted).toEqual([]);
		} finally {
			await ctx.close();
		}
	});
});
