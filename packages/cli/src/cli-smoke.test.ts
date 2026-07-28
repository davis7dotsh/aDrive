import { createServer, type Server } from 'node:http';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { spawn } from 'node:child_process';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const downloaded = Buffer.from([0, 255, 17, 128, 42]);
let uploaded = Buffer.alloc(0);
let server: Server;
let endpoint = '';
let configHome = '';

const file = {
	id: '11111111-1111-4111-8111-111111111111',
	displayName: 'payload.bin',
	contentType: 'application/octet-stream',
	kind: 'file' as const,
	version: 1,
	sizeBytes: downloaded.length,
	public: true,
	createdAt: '2026-07-27T00:00:00.000Z',
	expiresAt: null,
	downloadCount: 0,
	lastDownloadAt: null
};

beforeAll(async () => {
	server = createServer((request, response) => {
		if (request.method === 'PUT' && request.url === '/api/files') {
			const chunks: Array<Buffer> = [];
			request.on('data', (chunk: Buffer) => chunks.push(chunk));
			request.on('end', () => {
				uploaded = Buffer.concat(chunks);
				response.setHeader('Content-Type', 'application/json');
				response.end(
					JSON.stringify({
						file: { ...file, sizeBytes: uploaded.length },
						url: `http://content.test/f/${file.id}`,
						forcedPublic: false
					})
				);
			});
			return;
		}
		if (
			request.method === 'GET' &&
			request.url === `/api/files/${file.id}/content`
		) {
			response.setHeader(
				'Content-Disposition',
				`attachment; filename="${file.displayName}"`
			);
			response.end(downloaded);
			return;
		}
		if (request.method === 'GET' && request.url === '/api/tags') {
			response.setHeader('Content-Type', 'application/json');
			response.end(JSON.stringify({ tags: [] }));
			return;
		}
		response.statusCode = 404;
		response.end();
	});
	await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
	const address = server.address();
	if (address === null || typeof address === 'string') {
		throw new Error('Test server did not bind a TCP port');
	}
	endpoint = `http://127.0.0.1:${address.port}`;
	configHome = await mkdtemp(join(tmpdir(), 'adrive-cli-test-'));
	const path = join(configHome, 'adrive', 'config.json');
	await mkdir(dirname(path), { recursive: true });
	await writeFile(
		path,
		JSON.stringify({
			endpoint,
			apiKey: 'adr_12345678_123456789012345678901234'
		}),
		{ mode: 0o600 }
	);
});

afterAll(async () => {
	await new Promise<void>((resolve, reject) =>
		server.close((cause) => (cause ? reject(cause) : resolve()))
	);
	await rm(configHome, { recursive: true, force: true });
});

const run = (args: ReadonlyArray<string>, input?: Buffer) =>
	new Promise<{
		readonly status: number | null;
		readonly stdout: Buffer;
		readonly stderr: Buffer;
	}>((resolve, reject) => {
		const child = spawn(
			process.execPath,
			[
				'--experimental-strip-types',
				join(import.meta.dirname, 'main.ts'),
				...args
			],
			{
				env: { ...process.env, XDG_CONFIG_HOME: configHome }
			}
		);
		const stdout: Array<Buffer> = [];
		const stderr: Array<Buffer> = [];
		child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk));
		child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk));
		child.once('error', reject);
		child.once('close', (status) =>
			resolve({
				status,
				stdout: Buffer.concat(stdout),
				stderr: Buffer.concat(stderr)
			})
		);
		child.stdin.end(input);
	});

describe('CLI stream and JSON contracts', () => {
	it('spools binary stdin, uploads it, and emits only one JSON result', async () => {
		const payload = Buffer.from([0, 1, 2, 255, 128, 64]);
		const result = await run(
			['--json', 'put', '-', '--name', 'payload.bin'],
			payload
		);
		expect(result.status).toBe(0);
		expect(result.stderr.toString()).toBe('');
		expect(uploaded).toEqual(payload);
		const lines = result.stdout.toString().trim().split('\n');
		expect(lines).toHaveLength(1);
		expect(JSON.parse(lines[0]!)).toMatchObject({
			file: { id: file.id },
			url: `http://content.test/f/${file.id}`
		});
	});

	it('writes downloaded binary bytes to stdout without status text', async () => {
		const result = await run(['get', file.id, '--output', '-']);
		expect(result.status).toBe(0);
		expect(result.stderr.toString()).toBe('');
		expect(result.stdout).toEqual(downloaded);
	});

	it('keeps JSON tag output machine-parseable', async () => {
		const result = await run(['--json', 'tag', 'list']);
		expect(result.status).toBe(0);
		expect(result.stderr.toString()).toBe('');
		expect(JSON.parse(result.stdout.toString())).toEqual({ tags: [] });
	});
});
