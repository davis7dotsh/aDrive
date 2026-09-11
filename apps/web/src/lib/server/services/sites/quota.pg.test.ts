import { Effect } from 'effect';
import { describe, expect, it } from 'vitest';
import { runWorkerProgram } from '../../edge';
import { PgSql } from '../../pg';
import { planLimits } from '../../plans';
import { ensureTenant } from '../../tenants';
import { testTenant } from '../../test/org';
import { createRouteContext } from '../../test/route-context';
import { Blobs } from '../blobs';
import { Sites } from '../sites';

const manifest = (sizeBytes: number, fileId?: string) => ({
	displayName: 'Quota site',
	...(fileId === undefined ? {} : { fileId }),
	assets: [{ path: 'index.html', sizeBytes, contentType: 'text/html' }]
});

describe('site replacement storage quota', () => {
	it.each([32, 16])(
		'publishes a %s-byte replacement at full quota and charges only the difference',
		async (replacementBytes) => {
			const ctx = await createRouteContext();
			const suffix = crypto.randomUUID().slice(0, 8);
			const tenant = testTenant(
				`org_site_quota_${suffix}`,
				`user_site_quota_${suffix}`
			);
			const limit = planLimits('free').storedBytes;
			const originalBytes = 32;
			const result = await runWorkerProgram(
				ctx.env,
				Effect.gen(function* () {
					const sql = yield* PgSql;
					yield* ensureTenant(sql, tenant);
					const sites = yield* Sites;
					const publish = (sizeBytes: number, fileId?: string) =>
						Effect.gen(function* () {
							const session = yield* sites.createSession(
								manifest(sizeBytes, fileId)
							);
							yield* sites.stageAsset({
								sessionId: session.sessionId,
								path: 'index.html',
								contentLength: String(sizeBytes),
								body: new Response('x'.repeat(sizeBytes)).body
							});
							return yield* sites.commit(session.sessionId);
						});
					const original = yield* publish(originalBytes);
					// Other retained content fills the remaining allowance. A site
					// replacement only consumes growth beyond its current assets.
					yield* sql`UPDATE org_usage SET stored_bytes = ${limit} WHERE org_id = ${tenant.orgId}`;
					const refusedNew = yield* Effect.result(
						sites.createSession(manifest(1))
					);
					const refusedGrowth = yield* Effect.result(
						sites.createSession(manifest(originalBytes + 1, original.file.id))
					);
					const replacement = yield* publish(
						replacementBytes,
						original.file.id
					);
					const usage = yield* sql<{ stored_bytes: number }>`
						SELECT stored_bytes FROM org_usage WHERE org_id = ${tenant.orgId}
					`;
					const asset = yield* sites.findAsset(original.file.id, 'index.html');
					const blobs = yield* Blobs;
					const stored = yield* blobs.get(asset.r2Key);
					const content = yield* Effect.promise(() =>
						new Response(stored.body).text()
					);
					return {
						original,
						replacement,
						refusedNew,
						refusedGrowth,
						storedBytes: usage[0]?.stored_bytes,
						content
					};
				}),
				{ orgId: tenant.orgId, userId: tenant.userId, orgSlug: tenant.slug }
			);
			for (const refused of [result.refusedNew, result.refusedGrowth]) {
				expect(refused).toMatchObject({
					_tag: 'Failure',
					failure: { _tag: 'InvalidRequest', status: 413 }
				});
			}
			expect(result.replacement.file).toMatchObject({
				id: result.original.file.id,
				version: 2,
				sizeBytes: replacementBytes
			});
			expect(result.replacement.cleanupPending).toBe(false);
			expect(result.storedBytes).toBe(limit + replacementBytes - originalBytes);
			expect(result.content).toBe('x'.repeat(replacementBytes));
		}
	);
});
