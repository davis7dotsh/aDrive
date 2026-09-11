import { execFile } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import Pg from 'pg';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { migrate } from '../../../scripts/pg-migrate.mjs';
import { createD1Export } from './test/d1-export';
import { TEST_DATABASE_URL } from './test/database';

const run = promisify(execFile);
const mover = fileURLToPath(
	new URL('../../../scripts/d1-to-postgres.mjs', import.meta.url)
);
const sourceTimestamp = '2024-03-01T12:30:00-05:00';
const expectedTimestamp = '2024-03-01T17:30:00.000Z';

const createMoveContext = async () => {
	const schema = `d1_move_test_${crypto.randomUUID().replaceAll('-', '')}`;
	const dump = mkdtempSync(join(tmpdir(), 'adrive-d1-move-'));
	const client = new Pg.Client({ connectionString: TEST_DATABASE_URL });
	await client.connect();
	await client.query(`CREATE SCHEMA ${schema}`);
	await client.query(`SET search_path TO ${schema}, public`);
	const url = new URL(TEST_DATABASE_URL);
	url.searchParams.set('options', `-csearch_path=${schema},public`);
	await migrate({ url: url.href, log: () => undefined });
	const source = createD1Export(dump);
	return {
		client,
		dump,
		source,
		move: (destination = url.href) =>
			run('bun', [mover, '--dump', dump, '--url', destination, '--wipe']),
		addFile: (id: string, body: string, extra = {}) => {
			source.insert('files', {
				id,
				display_name: `${id}.txt`,
				content_type: 'text/plain',
				created_at: sourceTimestamp,
				updated_at: sourceTimestamp,
				...extra
			});
			source.insert('file_versions', {
				file_id: id,
				version: 1,
				r2_key: `versions/${id}/1`,
				size_bytes: 12,
				content_type: 'text/plain',
				created_at: sourceTimestamp,
				text_content: body,
				thumbnail_size_bytes: null
			});
		},
		addStagedUpload: (
			id: string,
			r2Key: string,
			fileId = 'unfinished',
			status = 'open'
		) => {
			source.insert('site_upload_sessions', {
				id,
				file_id: fileId,
				display_name: 'Site',
				version: 1,
				status,
				created_at: sourceTimestamp,
				expires_at: '2024-03-02T00:00:00Z'
			});
			source.insert('staged_site_assets', {
				session_id: id,
				path: 'index.html',
				expected_size_bytes: 1,
				content_type: 'text/html',
				r2_key: r2Key,
				stored_size_bytes: 1,
				uploaded_at: sourceTimestamp
			});
		},
		seedDestination: () =>
			client.query(`INSERT INTO files
				(id, display_name, content_type, size_bytes, created_at, updated_at)
				VALUES ('existing', 'Keep me', 'text/plain', 1, now(), now())`),
		close: async () => {
			try {
				await client.query(`DROP SCHEMA ${schema} CASCADE`);
			} finally {
				await client.end();
				rmSync(dump, { recursive: true, force: true });
			}
		}
	};
};

describe('D1 data move', () => {
	let context: Awaited<ReturnType<typeof createMoveContext>>;
	beforeEach(async () => {
		context = await createMoveContext();
	});
	afterEach(async () => {
		await context?.close();
	});

	it('preserves SQL-looking text, converts values, and rebuilds keyword documents', async () => {
		const bodies = [
			'Keep files_fts, files_trgm, sqlite_sequence, _cf_KV, and d1_migrations.',
			'Keep REFERENCES files(id) ON DELETE CASCADE exactly as written.',
			"Keep this semicolon;\nthis newline, a 'quote', and PRAGMA foreign_keys=ON;"
		];
		for (const [index, body] of bodies.entries()) {
			context.addFile(`source-${index}`, body, {
				public: index === 0 ? 0 : 1,
				index_state: index === 0 ? 'disabled' : 'ready'
			});
		}
		context.source.insert('tags', {
			id: 'tag-1',
			name: 'files_fts',
			normalized_name: 'files_fts',
			created_at: sourceTimestamp
		});
		context.source.insert('file_tags', {
			file_id: 'source-0',
			tag_id: 'tag-1'
		});
		context.source.insert('api_keys', {
			id: 'key-1',
			name: 'Moved key',
			prefix: 'prefix',
			secret_hash: 'hash',
			scope: null,
			created_at: sourceTimestamp
		});
		await context.seedDestination();
		await context.move();
		const files = await context.client.query<{
			id: string;
			public: boolean;
			is_site: boolean;
			created_at: Date;
			index_state: string;
			indexed_version: number | null;
			index_cursor: number;
			index_attempts: number;
		}>('SELECT * FROM files ORDER BY id');
		expect(files.rows.map((row) => row.id)).toEqual([
			'source-0',
			'source-1',
			'source-2'
		]);
		expect(files.rows.map((row) => row.public)).toEqual([false, true, true]);
		expect(files.rows.every((row) => row.is_site === false)).toBe(true);
		expect(
			files.rows.every(
				(row) => row.created_at.toISOString() === expectedTimestamp
			)
		).toBe(true);
		expect(files.rows.map((row) => row.index_state)).toEqual([
			'disabled',
			'pending',
			'pending'
		]);
		expect(
			files.rows.every(
				(row) =>
					row.indexed_version === null &&
					row.index_cursor === 0 &&
					row.index_attempts === 0
			)
		).toBe(true);
		const versions = await context.client.query<{
			text_content: string;
			thumbnail_size_bytes: string;
		}>(
			'SELECT text_content, thumbnail_size_bytes FROM file_versions ORDER BY file_id'
		);
		expect(versions.rows.map((row) => row.text_content)).toEqual(bodies);
		expect(versions.rows.every((row) => row.thumbnail_size_bytes === '0')).toBe(
			true
		);
		const documents = await context.client.query<{
			body: string;
			tags: string;
		}>('SELECT body, tags FROM search_documents ORDER BY file_id');
		expect(documents.rows.map((row) => row.body)).toEqual(bodies);
		expect(documents.rows[0]?.tags).toBe('files_fts');
		expect(
			(await context.client.query('SELECT scope FROM api_keys')).rows
		).toEqual([{ scope: 'read-write' }]);
	});

	it('normalizes legacy extracted NUL text before rebuilding search documents', async () => {
		context.addFile('legacy', '\u0000Quarterly re\u0000port\nCafé 😀\u0000');
		await context.move();
		expect(
			(await context.client.query('SELECT text_content FROM file_versions'))
				.rows
		).toEqual([{ text_content: 'Quarterly report\nCafé 😀' }]);
		expect(
			(
				await context.client.query(`
				SELECT body, tsv @@ websearch_to_tsquery('english', 'quarterly report') AS hit
				FROM search_documents`)
			).rows
		).toEqual([{ body: 'Quarterly report\nCafé 😀', hit: true }]);
	});

	it('preserves cleanup ownership for staged objects without queuing live site assets', async () => {
		context.addFile('published', 'Published site', {
			kind: 'site',
			is_site: 1
		});
		context.source.insert('site_assets', {
			file_id: 'published',
			version: 1,
			path: 'index.html',
			r2_key: 'live-key',
			content_type: 'text/html',
			size_bytes: 1
		});
		context.addStagedUpload('open-session', 'staged-key');
		context.addStagedUpload(
			'completed-live',
			'live-key',
			'published',
			'complete'
		);
		context.addStagedUpload(
			'completed-orphan',
			'orphan-key',
			'published',
			'complete'
		);
		// Existing cleanup attempts must survive, rather than being reset by
		// the same staged key discovered in the source exports.
		context.source.insert('pending_site_asset_deletes', {
			r2_key: 'staged-key',
			file_id: 'unfinished',
			version: 1,
			queued_at: sourceTimestamp,
			attempts: 3,
			last_error: 'retry me'
		});
		await context.move();
		expect(
			(
				await context.client.query(`
				SELECT r2_key, file_id, attempts FROM pending_site_asset_deletes ORDER BY r2_key`)
			).rows
		).toEqual([
			{ r2_key: 'orphan-key', file_id: 'published', attempts: 0 },
			{ r2_key: 'staged-key', file_id: 'unfinished', attempts: 3 }
		]);
		expect(
			(await context.client.query('SELECT r2_key FROM site_assets')).rows
		).toEqual([{ r2_key: 'live-key' }]);
		expect(
			(await context.client.query('SELECT id FROM site_upload_sessions')).rows
		).toEqual([]);
		expect(
			(await context.client.query('SELECT session_id FROM staged_site_assets'))
				.rows
		).toEqual([]);
	});

	it('rejects stored staged assets whose upload session is missing before wiping', async () => {
		await context.seedDestination();
		context.source.insert('staged_site_assets', {
			session_id: 'missing-session',
			path: 'index.html',
			r2_key: 'unowned-key',
			expected_size_bytes: 1,
			stored_size_bytes: 1,
			content_type: 'text/html',
			uploaded_at: sourceTimestamp
		});
		await expect(
			context.move('postgres://unused:unused@127.0.0.1:1/unused')
		).rejects.toThrow('stored staged assets without their upload sessions');
		await expect(context.move()).rejects.toThrow(
			'stored staged assets without their upload sessions'
		);
		expect((await context.client.query('SELECT id FROM files')).rows).toEqual([
			{ id: 'existing' }
		]);
	});

	it('clears existing sign-in state while importing persistent API keys', async () => {
		await context.client.query(`
			INSERT INTO api_keys (id, name, prefix, secret_hash, created_at)
			VALUES ('old-key', 'Old key', 'old-prefix', 'old-hash', now());
			INSERT INTO device_codes
				(device_code_hash, user_code, status, interval_seconds, expires_at,
				 created_at, api_key_id)
			VALUES ('old-device', 'OLD-CODE', 'consumed', 5, now() + interval '1 day',
				now(), 'old-key');
			INSERT INTO dashboard_sessions (token_hash, created_at, expires_at, last_used_at)
			VALUES ('old-session', now(), now() + interval '1 day', now());
			INSERT INTO credential_state (id, passcode_hash, rotated_at)
			VALUES (1, repeat('a', 64), now());
		`);
		context.source.insert('api_keys', {
			id: 'moved-key',
			name: 'Moved key',
			prefix: 'moved-prefix',
			secret_hash: 'moved-hash',
			scope: 'read-only',
			created_at: sourceTimestamp
		});
		await context.move();
		expect(
			(await context.client.query('SELECT token_hash FROM dashboard_sessions'))
				.rows
		).toEqual([]);
		expect(
			(await context.client.query('SELECT id FROM credential_state')).rows
		).toEqual([]);
		expect(
			(await context.client.query('SELECT device_code_hash FROM device_codes'))
				.rows
		).toEqual([]);
		expect(
			(await context.client.query('SELECT id, scope FROM api_keys')).rows
		).toEqual([{ id: 'moved-key', scope: 'read-only' }]);
	});

	it('rejects missing canonical tables before connecting or wiping Postgres', async () => {
		await context.seedDestination();
		rmSync(join(context.dump, 'file_versions.sql'));
		await expect(
			context.move('postgres://unused:unused@127.0.0.1:1/unused')
		).rejects.toThrow('D1 export is missing required tables: file_versions');
		await expect(context.move()).rejects.toThrow(
			'D1 export is missing required tables: file_versions'
		);
		expect((await context.client.query('SELECT id FROM files')).rows).toEqual([
			{ id: 'existing' }
		]);
	});

	it('rolls back the wipe, imported rows, and staging cleanup when search rebuilding fails', async () => {
		await context.seedDestination();
		context.addFile('source', 'Valid file imported before the failure');
		context.addStagedUpload('staged-session', 'staged-key');
		await context.client.query(`
			CREATE FUNCTION fail_search_build() RETURNS trigger LANGUAGE plpgsql AS $$
			BEGIN RAISE EXCEPTION 'forced search failure'; END;
			$$;
			CREATE TRIGGER fail_search_build BEFORE INSERT ON search_documents
			FOR EACH ROW EXECUTE FUNCTION fail_search_build();
		`);
		await expect(context.move()).rejects.toThrow('forced search failure');
		expect((await context.client.query('SELECT id FROM files')).rows).toEqual([
			{ id: 'existing' }
		]);
		expect(
			(await context.client.query('SELECT * FROM file_versions')).rows
		).toEqual([]);
		expect(
			(
				await context.client.query(
					'SELECT r2_key FROM pending_site_asset_deletes'
				)
			).rows
		).toEqual([]);
	});
});
