import type { FileSummary } from '@adrive/shared';
import { describe, expect, it } from 'vitest';
import { mintPrivateGrant } from './private-grant';
import {
	buildFileContentLink,
	contentLinkJsonResponse,
	contentLinkRedirectResponse
} from './file-content-link';

const file = (isPublic: boolean): FileSummary => ({
	id: 'file / one',
	displayName: 'example.bin',
	contentType: 'application/octet-stream',
	kind: 'file',
	version: 3,
	sizeBytes: 4,
	public: isPublic,
	createdAt: '2026-07-27T00:00:00.000Z',
	expiresAt: null,
	downloadCount: 0,
	lastDownloadAt: null,
	indexState: 'disabled',
	indexedVersion: null,
	indexAttempts: 0,
	indexError: null
});

const config = {
	contentOrigin: 'https://content.example.test'
};

describe('file content links', () => {
	it('keeps current public links stable and scopes public history links', async () => {
		const current = await buildFileContentLink(config, { file: file(true) });
		const history = await buildFileContentLink(config, { file: file(true) }, 3);

		expect(current).toEqual({
			url: 'https://content.example.test/f/file%20%2F%20one',
			expiresAt: null,
			version: 3,
			public: true
		});
		expect(history.url).toBe(
			'https://content.example.test/f/file%20%2F%20one?v=3'
		);
	});

	it('always scopes private links to the resolved version and an expiry', async () => {
		const grant = await mintPrivateGrant({
			signingKey: 'kS0x8xqQZ2mcYYhBBLVBn1dnlTjluNkETdn3_1v4Gxw',
			contentOrigin: config.contentOrigin,
			fileId: file(false).id,
			version: 3,
			now: new Date('2026-07-27T12:00:00.000Z')
		});
		const link = await buildFileContentLink(
			config,
			{ file: file(false) },
			undefined,
			grant
		);
		const url = new URL(link.url);

		expect(url.origin).toBe(config.contentOrigin);
		expect(url.searchParams.get('v')).toBe('3');
		expect(url.searchParams.get('e')).toBe('1785154500');
		expect(url.searchParams.get('g')).toMatch(/^[A-Za-z0-9_-]{43}$/);
		expect(link.expiresAt).toBe('2026-07-27T12:15:00.000Z');
		expect(link.public).toBe(false);
	});

	it('keeps dashboard responses metadata-only or bodyless', async () => {
		const link = await buildFileContentLink(config, { file: file(true) });
		const json = contentLinkJsonResponse(link);
		const redirect = contentLinkRedirectResponse(link);

		expect(await json.json()).toEqual(link);
		expect(json.headers.get('content-type')).toContain('application/json');
		expect(redirect.status).toBe(307);
		expect(redirect.headers.get('location')).toBe(link.url);
		expect((await redirect.arrayBuffer()).byteLength).toBe(0);
	});
});
