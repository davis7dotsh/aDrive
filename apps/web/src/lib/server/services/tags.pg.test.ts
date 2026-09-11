import { Effect, Layer } from 'effect';
import Pg from 'pg';
import { expect, it } from 'vitest';
import { PgSql, pgLayer } from '../pg';
import { ensureTestOrg, TEST_ORG_ID } from '../test/org';
import { testPgLayer } from '../test/pg';
import { CurrentOrg } from './current-org';
import { TEST_DATABASE_URL } from '../test/database';
import { Tags, TagsLive } from './tags';

const tagRunner = (applicationName: string) => {
	const url = new URL(TEST_DATABASE_URL);
	url.searchParams.set('application_name', applicationName);
	const layer = TagsLive.pipe(
		Layer.provide(
			Layer.merge(
				pgLayer({ connectionString: url.href }),
				Layer.succeed(CurrentOrg, {
					id: TEST_ORG_ID,
					slug: TEST_ORG_ID.replaceAll('_', '-')
				})
			)
		)
	);
	return <A, E>(effect: Effect.Effect<A, E, Tags>) =>
		Effect.runPromise(effect.pipe(Effect.provide(layer)));
};

it('serializes overlapping replacements on a file with no existing tags', async () => {
	await Effect.runPromise(
		Effect.flatMap(PgSql, ensureTestOrg).pipe(Effect.provide(testPgLayer()))
	);
	const suffix = crypto.randomUUID().replaceAll('-', '');
	const fileId = `tag-race-${suffix}`;
	const firstTag = `first-${suffix}`;
	const secondTag = `second-${suffix}`;
	const barrierName = `pause_file_tags_${suffix}`;
	const lockId = crypto.getRandomValues(new Int32Array(1))[0]!;
	const run = tagRunner(fileId);
	const replace = (name: string) =>
		run(Effect.flatMap(Tags, (tags) => tags.setFileTags(fileId, [name])));
	const writes: ReturnType<typeof replace>[] = [];
	const control = new Pg.Client({ connectionString: TEST_DATABASE_URL });
	await control.connect();
	try {
		await control.query(
			`INSERT INTO files (org_id, id, display_name, content_type, size_bytes, created_at, updated_at)
			VALUES ($2, $1, 'Tag replacement fixture', 'text/plain', 0, now(), now())`,
			[fileId, TEST_ORG_ID]
		);
		await control.query(
			`INSERT INTO file_versions (org_id, file_id, version, r2_key, size_bytes, content_type, created_at)
			VALUES ($2, $1, 1, $1, 0, 'text/plain', now())`,
			[fileId, TEST_ORG_ID]
		);
		// Hold the first write after DELETE and before INSERT. Without the
		// parent lock both replacements delete an empty set, then their
		// disjoint inserts commit a union that neither caller requested.
		await control.query(`
			CREATE FUNCTION ${barrierName}() RETURNS trigger LANGUAGE plpgsql AS $$
			BEGIN
				PERFORM pg_advisory_xact_lock(${lockId});
				RETURN NEW;
			END
			$$;
			CREATE TRIGGER ${barrierName} BEFORE INSERT ON file_tags
			FOR EACH ROW WHEN (NEW.file_id = '${fileId}')
			EXECUTE FUNCTION ${barrierName}();
		`);
		await control.query('SELECT pg_advisory_lock($1)', [lockId]);
		const waitForBlockedWrites = (count: number) =>
			expect
				.poll(
					async () =>
						(
							await control.query(
								`SELECT pid FROM pg_stat_activity
								WHERE datname = current_database() AND application_name = $1
								AND wait_event_type = 'Lock'`,
								[fileId]
							)
						).rowCount,
					{ timeout: 5_000, interval: 10 }
				)
				.toBe(count);

		writes.push(replace(firstTag));
		await waitForBlockedWrites(1);
		writes.push(replace(secondTag));
		await waitForBlockedWrites(2);
		await control.query('SELECT pg_advisory_unlock($1)', [lockId]);
		await Promise.all(writes);

		const { rows } = await control.query(
			`SELECT t.name FROM file_tags ft JOIN tags t ON t.id = ft.tag_id
			WHERE ft.file_id = $1 ORDER BY t.name`,
			[fileId]
		);
		expect(rows).toEqual([{ name: secondTag }]);
		expect(
			(
				await control.query(
					'SELECT tags FROM search_documents WHERE file_id = $1',
					[fileId]
				)
			).rows
		).toEqual([{ tags: secondTag }]);
	} finally {
		await control.query('SELECT pg_advisory_unlock($1)', [lockId]);
		await Promise.allSettled(writes);
		try {
			await control.query(`DROP TRIGGER IF EXISTS ${barrierName} ON file_tags`);
			await control.query(`DROP FUNCTION IF EXISTS ${barrierName}()`);
			await control.query('DELETE FROM files WHERE id = $1', [fileId]);
			await control.query('DELETE FROM tags WHERE name = ANY($1::text[])', [
				[firstTag, secondTag]
			]);
		} finally {
			await control.end();
		}
	}
});

it('preserves NotFound when the file to tag does not exist', async () => {
	const fileId = `missing-${crypto.randomUUID()}`;
	const run = tagRunner(fileId);
	const result = await run(
		Effect.flatMap(Tags, (tags) => tags.setFileTags(fileId, [])).pipe(
			Effect.match({ onFailure: (failure) => failure, onSuccess: () => null })
		)
	);
	expect(result).toMatchObject({ _tag: 'NotFound', id: fileId });
});
