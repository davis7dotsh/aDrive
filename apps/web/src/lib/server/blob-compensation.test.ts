import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Effect } from 'effect';
import {
	compensateBlobFailure,
	deferredBlobDeleteCommand
} from './blob-compensation';

const databases: DatabaseSync[] = [];

afterEach(() => {
	for (const database of databases) database.close();
	databases.length = 0;
});

describe('blob compensation', () => {
	it('preserves the commit failure after a failed delete is queued', async () => {
		const queued = vi.fn(() => Effect.void);
		const failure = await Effect.runPromise(
			Effect.flip(
				compensateBlobFailure(
					'commit failed',
					Effect.fail('delete failed'),
					queued,
					() => undefined
				)
			)
		);

		expect(failure).toBe('commit failed');
		expect(queued).toHaveBeenCalledOnce();
	});

	it('preserves the commit failure when both delete and queue fail', async () => {
		const report = vi.fn();
		const failure = await Effect.runPromise(
			Effect.flip(
				compensateBlobFailure(
					'commit failed',
					Effect.fail('delete failed'),
					() => Effect.fail('queue failed'),
					report
				)
			)
		);

		expect(failure).toBe('commit failed');
		expect(report).toHaveBeenCalledOnce();
	});

	it('records failed R2 cleanup in the durable lifecycle queue', () => {
		const database = new DatabaseSync(':memory:');
		databases.push(database);
		database.exec(
			readFileSync(
				new URL('../../../migrations/0003_sites.sql', import.meta.url),
				'utf8'
			)
		);
		const command = deferredBlobDeleteCommand(
			'v/file-id/orphan',
			'file-id',
			2,
			'2026-07-30T00:00:00.000Z',
			'delete failed'
		);

		database.prepare(command.sql).run(...command.bindings);

		expect(
			database
				.prepare(
					`SELECT r2_key, file_id, version, attempts, last_error
					FROM pending_site_asset_deletes`
				)
				.get()
		).toEqual({
			r2_key: 'v/file-id/orphan',
			file_id: 'file-id',
			version: 2,
			attempts: 1,
			last_error: 'delete failed'
		});
	});
});
