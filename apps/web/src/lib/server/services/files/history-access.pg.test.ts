import { Effect } from 'effect';
import { Client } from 'pg';
import { describe, expect, it, vi } from 'vitest';

vi.mock('$app/server', async () => {
	const { mockGetRequestEvent } = await import('../../test/route-context.js');
	return mockGetRequestEvent();
});

import { runWorkerProgram, type AppServices } from '../../edge';
import { resolveFileContentLink } from '../../file-content-link';
import { PgSql } from '../../pg';
import { ensureTenant } from '../../tenants';
import { TEST_DATABASE_URL } from '../../test/database';
import { testTenant } from '../../test/org';
import { call, createRouteContext } from '../../test/route-context';
import { Admin } from '../admin';
import { Files } from '../files';
import { Scanner } from '../scanner';

const setup = async () => {
	const ctx = await createRouteContext();
	const suffix = crypto.randomUUID().replaceAll('-', '').slice(0, 16);
	const tenant = testTenant(`org_history_${suffix}`, `user_history_${suffix}`);
	await runWorkerProgram(
		ctx.env,
		Effect.flatMap(PgSql, (sql) => ensureTenant(sql, tenant))
	);
	const control = new Client({ connectionString: TEST_DATABASE_URL });
	await control.connect();
	await control.query("UPDATE orgs SET trust = 'verified' WHERE id = $1", [
		tenant.orgId
	]);
	const run = <A, E>(program: Effect.Effect<A, E, AppServices>) =>
		runWorkerProgram(ctx.env, program, {
			orgId: tenant.orgId,
			userId: tenant.userId
		});
	const first = (isPublic: boolean) =>
		run(
			Effect.flatMap(Files, (files) =>
				files.upload({
					displayName: 'history.txt',
					contentType: 'text/plain',
					public: isPublic,
					contentLength: '5',
					body: new Response('first').body,
					tags: [],
					expiresAt: null
				})
			)
		);
	const replace = (id: string) =>
		run(
			Effect.flatMap(Files, (files) =>
				files.uploadVersion({
					id,
					contentType: 'text/plain',
					contentLength: '6',
					body: new Response('second').body
				})
			)
		);
	const scan = (id: string, version: number) =>
		run(
			Effect.flatMap(Scanner, (scanner) =>
				scanner.runOne({
					kind: 'scan',
					orgId: tenant.orgId,
					fileId: id,
					version
				})
			)
		);
	const serve = async (id: string, version: number, url?: string) => {
		const { GET } = await import('../../../../routes/f/[id]/+server.js');
		return call(
			GET,
			await ctx.contentEvent({
				slug: tenant.slug,
				path: `/f/${id}?v=${version}`,
				params: { id },
				...(url ? { url: new URL(url) } : {})
			})
		);
	};
	const cleanup = async () => {
		try {
			const keys = await control.query<{ r2_key: string }>(
				'SELECT r2_key FROM file_versions WHERE org_id = $1',
				[tenant.orgId]
			);
			if (keys.rows.length > 0)
				await ctx.env.BUCKET.delete(keys.rows.map((row) => row.r2_key));
			await control.query('DELETE FROM files WHERE org_id = $1', [
				tenant.orgId
			]);
			await control.query('DELETE FROM orgs WHERE id = $1', [tenant.orgId]);
			await control.query('DELETE FROM users WHERE id = $1', [tenant.userId]);
		} finally {
			await control.end();
		}
	};
	return { control, tenant, run, first, replace, scan, serve, cleanup };
};

describe('historical file access requires that version to be cleared', () => {
	it.each([false, true])(
		'keeps an unscanned first version private after replacement publishes (initial public intent: %s)',
		async (publicIntent) => {
			const fixture = await setup();
			try {
				const uploaded = await fixture.first(publicIntent);
				const id = uploaded.file.id;
				await fixture.replace(id);
				if (!publicIntent) {
					await fixture.run(
						Effect.flatMap(Files, (files) => files.setVisibility(id, true))
					);
				}
				await fixture.scan(id, 2);
				expect(await (await fixture.serve(id, 2)).text()).toBe('second');
				await expect(fixture.serve(id, 1)).rejects.toMatchObject({
					status: 404
				});
				const link = await fixture.run(resolveFileContentLink(id, 1));
				expect(link.public).toBe(false);
				expect(new URL(link.url).searchParams.has('g')).toBe(true);
				const owned = await fixture.serve(id, 1, link.url);
				expect(await owned.text()).toBe('first');
				expect(owned.headers.get('cache-control')).toContain('private');
				// Once v1 itself completes clean checks it can use a pinned public
				// URL too; publishing v2 alone did not authorize those older bytes.
				await fixture.scan(id, 1);
				expect(await (await fixture.serve(id, 1)).text()).toBe('first');
			} finally {
				await fixture.cleanup();
			}
		}
	);

	it('keeps a malicious older version blocked after an operator clears the current version', async () => {
		const fixture = await setup();
		try {
			const uploaded = await fixture.first(true);
			const id = uploaded.file.id;
			await fixture.replace(id);
			await fixture.scan(id, 2);
			// Capture a legitimate owner grant before the historical verdict.
			const link = await fixture.run(resolveFileContentLink(id, 1));
			await fixture.control.query(
				`INSERT INTO scan_verdicts (file_id, org_id, version, source, verdict)
				VALUES ($1, $2, 1, 'prior-check', 'malicious')`,
				[id, fixture.tenant.orgId]
			);
			await fixture.scan(id, 1);
			await fixture.run(
				Effect.flatMap(Admin, (admin) =>
					admin.markFile(id, 2, 'clean', fixture.tenant.userId)
				)
			);
			await fixture.run(
				Effect.flatMap(Files, (files) => files.setVisibility(id, true))
			);
			await fixture.scan(id, 2);
			expect(await (await fixture.serve(id, 2)).text()).toBe('second');
			await expect(fixture.serve(id, 1)).rejects.toMatchObject({ status: 404 });
			await expect(fixture.serve(id, 1, link.url)).rejects.toMatchObject({
				status: 404
			});
			// The same version's operator verdict is the only override; a
			// current-version decision above cannot clear another version.
			await fixture.control.query(
				`INSERT INTO scan_verdicts (file_id, org_id, version, source, verdict)
				VALUES ($1, $2, 1, 'admin', 'clean')`,
				[id, fixture.tenant.orgId]
			);
			expect(await (await fixture.serve(id, 1)).text()).toBe('first');
		} finally {
			await fixture.cleanup();
		}
	});
});
