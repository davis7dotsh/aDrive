import { describe, expect, it } from 'vitest';
import {
	parseApiKeyCreateResponse,
	parseApiKeyListResponse,
	parseFileContentLink,
	parseFileDetailResponse,
	parseFileListResponse,
	parseFileMutationResponse,
	parseFileTagsResponse,
	parseSessionsRevokedResponse,
	parseTagResponse,
	parseUploadResponse
} from './parse';

const file = {
	id: 'file-1',
	displayName: 'photo.png',
	contentType: 'image/png',
	kind: 'file',
	version: 3,
	sizeBytes: 1024,
	public: true,
	htmlForcedPublic: false,
	createdAt: '2026-07-30T12:00:00.000Z',
	updatedAt: '2026-07-30T12:00:00.000Z',
	deletedAt: null,
	expiresAt: null,
	downloadCount: 2,
	lastDownloadAt: null,
	indexState: 'ready',
	indexedVersion: 3,
	indexAttempts: 1,
	indexError: null,
	tags: []
};

const tag = {
	id: 'tag-1',
	name: 'reports',
	normalizedName: 'reports',
	color: null,
	fileCount: 4,
	createdAt: '2026-07-30T12:00:00.000Z'
};

const listResponse = {
	files: [file],
	nextCursor: null,
	tags: [tag],
	contentOrigin: 'https://files.example',
	maxUploadBytes: 99_614_720,
	semantic: {
		enabled: false,
		indexedChunks: 0,
		dimensions: 384,
		model: '@cf/baai/bge-small-en-v1.5',
		costNotice: 'notice'
	}
};

describe('dashboard response parsing', () => {
	it('accepts a well-formed file list, ignoring unknown keys', () => {
		const parsed = parseFileListResponse({
			...listResponse,
			someFutureField: { anything: true }
		});
		expect(parsed.files[0]?.id).toBe('file-1');
		expect(parsed.files[0]?.deletedAt).toBeNull();
		expect(parsed.semantic.dimensions).toBe(384);
	});

	it('rejects a file list with a missing required field', () => {
		const { tags, ...missing } = listResponse;
		expect(() => parseFileListResponse(missing)).toThrow(
			'The server returned unexpected data'
		);
	});

	it('rejects a file list with a wrong typed field', () => {
		expect(() =>
			parseFileListResponse({ ...listResponse, maxUploadBytes: 'big' })
		).toThrow();
		expect(() =>
			parseFileListResponse({
				...listResponse,
				files: [{ ...file, version: 2.5 }]
			})
		).toThrow();
		expect(() =>
			parseFileListResponse({
				...listResponse,
				files: [{ ...file, kind: 'folder' }]
			})
		).toThrow();
	});

	it('parses a detail response with versions', () => {
		const parsed = parseFileDetailResponse({
			file,
			versions: [
				{
					version: 2,
					sizeBytes: 512,
					contentType: 'image/png',
					createdAt: '2026-07-29T12:00:00.000Z'
				}
			],
			nextVersionsCursor: 'cursor',
			availableTags: [tag],
			contentOrigin: 'https://files.example',
			maxUploadBytes: 99_614_720,
			semanticEnabled: false
		});
		expect(parsed.versions[0]?.version).toBe(2);
		expect(parsed.availableTags[0]?.name).toBe('reports');
	});

	it('parses content links, mutations, tags, and uploads', () => {
		expect(
			parseFileContentLink({
				url: 'https://files.example/f/file-1?v=3&e=1&g=sig',
				expiresAt: '2026-07-30T12:15:00.000Z',
				version: 3,
				public: false
			}).public
		).toBe(false);

		expect(
			parseFileMutationResponse({ file, forcedPublic: false }).file.id
		).toBe('file-1');
		expect(parseFileTagsResponse({ file }).file.id).toBe('file-1');
		expect(parseTagResponse({ tag }).tag.id).toBe('tag-1');

		const uploaded = parseUploadResponse({
			file: {
				// Uploads return a FileSummary without dashboard-only fields.
				id: 'file-1',
				displayName: 'photo.png',
				contentType: 'image/png',
				kind: 'file',
				version: 1,
				sizeBytes: 1024,
				public: true,
				createdAt: '2026-07-30T12:00:00.000Z',
				expiresAt: null,
				downloadCount: 0,
				lastDownloadAt: null,
				indexState: 'pending',
				indexedVersion: null,
				indexAttempts: 0,
				indexError: null
			},
			url: 'https://files.example/f/file-1',
			forcedPublic: false
		});
		expect(uploaded.url).toBe('https://files.example/f/file-1');
	});

	it('parses API key and session responses', () => {
		const key = {
			id: 'key-1',
			name: 'cli',
			prefix: 'adr_abc',
			scope: 'read-write',
			createdAt: '2026-07-30T12:00:00.000Z',
			expiresAt: null,
			lastUsedAt: null,
			revokedAt: null
		};
		expect(parseApiKeyListResponse({ keys: [key] }).keys[0]?.name).toBe('cli');
		expect(parseApiKeyCreateResponse({ key, token: 'adr_secret' }).token).toBe(
			'adr_secret'
		);
		expect(parseSessionsRevokedResponse({ revoked: 3 }).revoked).toBe(3);
		expect(() =>
			parseApiKeyListResponse({ keys: [{ ...key, scope: 'admin' }] })
		).toThrow();
	});
});
