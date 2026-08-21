import { afterEach, describe, expect, it, vi } from 'vitest';
import { getContentLink } from './api';

const fetchMock = vi.hoisted(() => vi.fn());

afterEach(() => {
	fetchMock.mockReset();
	vi.unstubAllGlobals();
});

const stubLink = (payload: Record<string, unknown>) => {
	const json = () => JSON.stringify(payload);
	vi.stubGlobal(
		'fetch',
		fetchMock.mockImplementation(
			async () => new Response(json(), { status: 200 })
		)
	);
};

describe('content link memoization', () => {
	it('reuses an unexpired private link without another request', async () => {
		stubLink({
			url: 'https://content.example/f/id-a?v=3&e=2000000000&g=sig',
			expiresAt: '2033-05-01T00:00:00.000Z',
			version: 3,
			public: false
		});

		await getContentLink('token', 'id-a', 3);
		await getContentLink('token', 'id-a', 3);

		expect(fetchMock).toHaveBeenCalledTimes(1);
	});

	it('mints again for a different version or grant requirement', async () => {
		stubLink({
			url: 'https://content.example/f/id-b?v=3&e=2000000000&g=sig',
			expiresAt: '2033-05-01T00:00:00.000Z',
			version: 3,
			public: false
		});

		await getContentLink('token', 'id-b', 3);
		await getContentLink('token', 'id-b', 4);
		await getContentLink('token', 'id-b', 3, undefined, false, true);

		expect(fetchMock).toHaveBeenCalledTimes(3);
	});

	it('does not memoize unavailable or already-expired links', async () => {
		stubLink({
			url: 'https://content.example/f/id-c?v=3&e=1700000000&g=sig',
			expiresAt: '2023-11-14T00:00:00.000Z',
			version: 3,
			public: false
		});

		await getContentLink('token', 'id-c', 3);
		await getContentLink('token', 'id-c', 3);
		await getContentLink('token', 'id-c', 3, undefined, true);

		// Expired grants are never cached; unavailable links always refetch.
		expect(fetchMock).toHaveBeenCalledTimes(3);
	});

	it('does not memoize public links', async () => {
		stubLink({
			url: 'https://content.example/f/id-d',
			expiresAt: null,
			version: 3,
			public: true
		});

		await getContentLink('token', 'id-d', 3);
		await getContentLink('token', 'id-d', 3);

		expect(fetchMock).toHaveBeenCalledTimes(2);
	});
});
