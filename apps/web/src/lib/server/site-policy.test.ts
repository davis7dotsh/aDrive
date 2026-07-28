import { describe, expect, it } from 'vitest';
import { InvalidRequest } from './errors';
import {
	assertOpenSiteSession,
	inferSiteContentType,
	isSiteVersionRequestServable,
	prepareSiteManifest,
	siteCleanupDisposition,
	validateCommittedAssets
} from './site-policy';

describe('site upload policy', () => {
	it('normalizes the manifest and infers content types', () => {
		expect(
			prepareSiteManifest(
				{
					displayName: 'dist',
					assets: [
						{
							path: 'index.html',
							sizeBytes: 20,
							contentType: 'application/octet-stream'
						},
						{
							path: 'assets/app.css',
							sizeBytes: 10,
							contentType: 'application/octet-stream'
						}
					]
				},
				100
			)
		).toEqual({
			displayName: 'dist',
			assets: [
				{ path: 'index.html', sizeBytes: 20, contentType: 'text/html' },
				{ path: 'assets/app.css', sizeBytes: 10, contentType: 'text/css' }
			]
		});
		expect(
			inferSiteContentType('asset.unknown', 'text/plain; charset=utf-8')
		).toBe('text/plain');
	});

	it('rejects duplicate, traversal, missing-index, and oversized manifests', () => {
		const asset = {
			path: 'index.html',
			sizeBytes: 20,
			contentType: 'text/html'
		};
		expect(() =>
			prepareSiteManifest({ displayName: 'dist', assets: [asset, asset] }, 100)
		).toThrow('duplicate');
		expect(() =>
			prepareSiteManifest(
				{
					displayName: 'dist',
					assets: [{ ...asset, path: '../index.html' }]
				},
				100
			)
		).toThrow('unsafe');
		expect(() =>
			prepareSiteManifest(
				{
					displayName: 'dist',
					assets: [{ ...asset, path: 'nested/index.html' }]
				},
				100
			)
		).toThrow('root index.html');
		expect(() =>
			prepareSiteManifest(
				{ displayName: 'dist', assets: [{ ...asset, sizeBytes: 101 }] },
				100
			)
		).toThrow(InvalidRequest);
	});

	it('validates session state and every staged asset before commit', () => {
		expect(() =>
			assertOpenSiteSession(
				{ status: 'complete', expiresAt: '2099-01-01T00:00:00.000Z' },
				new Date('2026-01-01T00:00:00.000Z')
			)
		).toThrow('no longer open');
		expect(() =>
			assertOpenSiteSession(
				{ status: 'open', expiresAt: '2025-01-01T00:00:00.000Z' },
				new Date('2026-01-01T00:00:00.000Z')
			)
		).toThrow('expired');
		expect(() =>
			validateCommittedAssets([
				{
					path: 'index.html',
					expectedSizeBytes: 5,
					storedSizeBytes: 4,
					r2Key: 'staged'
				}
			])
		).toThrow('incomplete');
		expect(
			validateCommittedAssets([
				{
					path: 'index.html',
					expectedSizeBytes: 5,
					storedSizeBytes: 5,
					r2Key: 'staged'
				}
			])
		).toBe(5);
	});

	it('never serves version-selected site URLs', () => {
		expect(isSiteVersionRequestServable(null)).toBe(true);
		expect(isSiteVersionRequestServable('1')).toBe(false);
		expect(isSiteVersionRequestServable('2')).toBe(false);
	});

	it('keeps deletion records retryable when R2 cleanup fails', () => {
		expect(siteCleanupDisposition(['old-a', 'old-b'], false)).toEqual({
			deleteFromQueue: [],
			remainsPending: true
		});
		expect(siteCleanupDisposition(['old-a', 'old-b'], true)).toEqual({
			deleteFromQueue: ['old-a', 'old-b'],
			remainsPending: false
		});
	});
});
