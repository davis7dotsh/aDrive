import { Effect } from 'effect';
import { describe, expect, it } from 'vitest';
import { queueDeferredBlobDelete } from './blob-compensation';
import { PgSql } from './pg';
import { testPgLayer } from './test/pg';

const run = <A, E>(effect: Effect.Effect<A, E, PgSql>) =>
	Effect.runPromise(effect.pipe(Effect.provide(testPgLayer())));

describe('deferred blob deletes on postgres', () => {
	it('records failed R2 cleanup once in the durable lifecycle queue', async () => {
		const r2Key = `v/bc-${crypto.randomUUID()}/orphan`;
		const rows = await run(
			Effect.gen(function* () {
				const sql = yield* PgSql;
				const queue = queueDeferredBlobDelete(
					sql,
					r2Key,
					'file-id',
					2,
					'2026-07-30T00:00:00.000Z',
					'delete failed'
				);
				yield* queue;
				yield* queue;
				return yield* sql<{
					file_id: string;
					version: number;
					attempts: number;
					last_error: string;
				}>`
					SELECT file_id, version, attempts, last_error
					FROM pending_site_asset_deletes
					WHERE r2_key = ${r2Key}`;
			})
		);
		expect(rows).toEqual([
			{
				file_id: 'file-id',
				version: 2,
				attempts: 1,
				last_error: 'delete failed'
			}
		]);
	});
});
