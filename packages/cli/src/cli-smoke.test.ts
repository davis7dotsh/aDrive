import { createServer, type Server } from 'node:http';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { spawn } from 'node:child_process';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const downloaded = Buffer.from([0, 255, 17, 128, 42]);
let uploaded = Buffer.alloc(0);
let dashboardServer: Server;
let contentServer: Server;
let endpoint = '';
let contentEndpoint = '';
let configHome = '';
let linkAuthorization: string | undefined;
let contentAuthorization: string | undefined;
let contentRequestUrl = '';
let devicePolls = 0;
let deviceAuthorizations = 0;
let uploadedContentLength: string | undefined;
let linkUrlOverride: string | undefined;

const deviceApiKey = 'adr_login123_123456789012345678901234';

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
	lastDownloadAt: null,
	indexState: 'disabled',
	indexedVersion: null,
	indexAttempts: 0,
	indexError: null
};

beforeAll(async () => {
	contentServer = createServer((request, response) => {
		if (
			request.method === 'GET' &&
			request.url?.startsWith(`/f/${file.id}?v=1&e=`)
		) {
			contentAuthorization = request.headers.authorization;
			contentRequestUrl = request.url;
			response.setHeader(
				'Content-Disposition',
				`attachment; filename="${file.displayName}"`
			);
			response.end(downloaded);
			return;
		}
		response.statusCode = 404;
		response.end();
	});
	await new Promise<void>((resolve) =>
		contentServer.listen(0, '127.0.0.1', resolve)
	);
	const contentAddress = contentServer.address();
	if (contentAddress === null || typeof contentAddress === 'string') {
		throw new Error('Content test server did not bind a TCP port');
	}
	contentEndpoint = `http://127.0.0.1:${contentAddress.port}`;

	dashboardServer = createServer((request, response) => {
		if (request.method === 'POST' && request.url === '/api/auth/device') {
			deviceAuthorizations += 1;
			devicePolls = 0;
			response.statusCode = 201;
			response.setHeader('Content-Type', 'application/json');
			response.end(
				JSON.stringify({
					deviceCode: `device-${deviceAuthorizations}`,
					userCode: 'ABCD-2345',
					verificationUri: `${endpoint}/`,
					verificationUriComplete: `${endpoint}/?device=ABCD-2345`,
					expiresIn: 600,
					interval: 0
				})
			);
			return;
		}
		if (request.method === 'POST' && request.url === '/api/auth/device/token') {
			devicePolls += 1;
			response.setHeader('Content-Type', 'application/json');
			if (devicePolls === 1) {
				response.statusCode = 202;
				response.end(JSON.stringify({ status: 'authorization_pending' }));
				return;
			}
			if (devicePolls === 2) {
				response.statusCode = 429;
				response.end(JSON.stringify({ status: 'slow_down' }));
				return;
			}
			response.end(JSON.stringify({ apiKey: deviceApiKey }));
			return;
		}
		if (request.method === 'PUT' && request.url === '/api/files') {
			uploadedContentLength = request.headers['content-length'];
			if (uploadedContentLength === undefined) {
				response.statusCode = 411;
				response.end('Content-Length is required');
				return;
			}
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
		if (request.method === 'GET' && request.url === '/api/files') {
			response.setHeader('Content-Type', 'application/json');
			response.end(
				JSON.stringify({
					files: [
						{
							...file,
							htmlForcedPublic: false,
							updatedAt: file.createdAt,
							deletedAt: null,
							tags: []
						}
					],
					nextCursor: null,
					tags: [],
					contentOrigin: contentEndpoint,
					maxUploadBytes: 100_000_000,
					semantic: {
						enabled: false,
						indexedChunks: 0,
						dimensions: 0,
						model: '',
						costNotice: ''
					}
				})
			);
			return;
		}
		if (
			request.method === 'GET' &&
			request.url === `/api/files/${file.id}/link`
		) {
			linkAuthorization = request.headers.authorization;
			response.setHeader('Content-Type', 'application/json');
			response.end(
				JSON.stringify({
					url:
						linkUrlOverride ??
						`${contentEndpoint}/f/${file.id}?v=1&e=1785154500&g=test`,
					expiresAt: '2026-07-27T12:15:00.000Z',
					version: 1,
					public: false
				})
			);
			return;
		}
		if (
			request.method === 'GET' &&
			request.url === `/api/files/${file.id}/content`
		) {
			response.statusCode = 500;
			response.end('CLI must not use the redirect endpoint');
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
	await new Promise<void>((resolve) =>
		dashboardServer.listen(0, '127.0.0.1', resolve)
	);
	const address = dashboardServer.address();
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
		dashboardServer.close((cause) => (cause ? reject(cause) : resolve()))
	);
	await new Promise<void>((resolve, reject) =>
		contentServer.close((cause) => (cause ? reject(cause) : resolve()))
	);
	await rm(configHome, { recursive: true, force: true });
});

// ADRIVE_TEST_BUNDLE points the whole suite at a built dist/adrive.mjs
// instead of the TS source — the release workflow runs both, so
// bundle-only breakage (CJS interop, tree-shaking, define wiring) is
// caught by the same contract tests.
const bundlePath = process.env.ADRIVE_TEST_BUNDLE;
const entrypoint = bundlePath
	? [bundlePath]
	: ['--experimental-strip-types', join(import.meta.dirname, 'main.ts')];

const run = (args: ReadonlyArray<string>, input?: Buffer) =>
	new Promise<{
		readonly status: number | null;
		readonly stdout: Buffer;
		readonly stderr: Buffer;
	}>((resolve, reject) => {
		const child = spawn(process.execPath, [...entrypoint, ...args], {
			env: { ...process.env, XDG_CONFIG_HOME: configHome }
		});
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
		expect(uploadedContentLength).toBe(String(payload.length));
		const lines = result.stdout.toString().trim().split('\n');
		expect(lines).toHaveLength(1);
		expect(JSON.parse(lines[0]!)).toMatchObject({
			file: { id: file.id },
			url: `http://content.test/f/${file.id}`
		});
	});

	it('lists files through the typed dashboard response', async () => {
		const result = await run(['--json', 'list']);
		expect(result.status).toBe(0);
		expect(result.stderr.toString()).toBe('');
		expect(JSON.parse(result.stdout.toString())).toMatchObject({
			files: [{ id: file.id, displayName: file.displayName }]
		});
	});

	it('writes downloaded binary bytes to stdout without status text', async () => {
		const result = await run(['get', file.id, '--output', '-']);
		expect(result.status).toBe(0);
		expect(result.stderr.toString()).toBe('');
		expect(result.stdout).toEqual(downloaded);
		expect(linkAuthorization).toBe(
			'Bearer adr_12345678_123456789012345678901234'
		);
		expect(contentAuthorization).toBeUndefined();
		expect(contentRequestUrl).toContain(`/f/${file.id}?v=1&e=`);
	});

	it('keeps JSON tag output machine-parseable', async () => {
		const result = await run(['--json', 'tag', 'list']);
		expect(result.status).toBe(0);
		expect(result.stderr.toString()).toBe('');
		expect(JSON.parse(result.stdout.toString())).toEqual({ tags: [] });
	});

	it('continues headless login through pending and slow-down responses', async () => {
		const result = await run(['login', endpoint, '--headless']);

		expect(result.status).toBe(0);
		expect(result.stderr.toString()).toBe('');
		expect(result.stdout.toString().trim().split('\n')).toEqual([
			'Approve this device with code ABCD-2345',
			`${endpoint}/?device=ABCD-2345`,
			`Logged in to ${endpoint}`
		]);
		expect(devicePolls).toBe(3);
		const saved = JSON.parse(
			await readFile(join(configHome, 'adrive', 'config.json'), 'utf8')
		);
		expect(saved).toEqual({
			endpoint,
			apiKey: deviceApiKey,
			contentOrigin: contentEndpoint
		});
	});

	it('keeps JSON login output parseable while polling pending states', async () => {
		const result = await run(['--json', 'login', endpoint, '--headless']);

		expect(result.status).toBe(0);
		expect(result.stderr.toString()).toBe('');
		expect(
			result.stdout
				.toString()
				.trim()
				.split('\n')
				.map((line) => JSON.parse(line))
		).toEqual([
			{
				status: 'authorization_required',
				userCode: 'ABCD-2345',
				verificationUri: `${endpoint}/`,
				verificationUriComplete: `${endpoint}/?device=ABCD-2345`
			},
			{ status: 'authenticated', endpoint }
		]);
		expect(devicePolls).toBe(3);
		const saved = JSON.parse(
			await readFile(join(configHome, 'adrive', 'config.json'), 'utf8')
		);
		expect(saved).toEqual({
			endpoint,
			apiKey: deviceApiKey,
			contentOrigin: contentEndpoint
		});
	});

	it('rejects a download link on an origin the config does not trust', async () => {
		linkUrlOverride = 'https://evil.example.com/f/steal';
		try {
			const result = await run(['get', file.id, '--output', '-']);
			expect(result.status).not.toBe(0);
			const combined = result.stdout.toString() + result.stderr.toString();
			expect(combined).toContain('unexpected origin');
			expect(result.stdout.toString()).not.toContain('evil.example.com/f');
		} finally {
			linkUrlOverride = undefined;
		}
	});

	it('rejects logging in to a non-local plain-http server without --allow-http', async () => {
		const result = await run(['login', 'http://drive.example.com']);
		expect(result.status).not.toBe(0);
		expect(result.stdout.toString() + result.stderr.toString()).toContain(
			'https'
		);
	});
});
