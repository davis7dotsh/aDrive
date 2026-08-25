import type { DashboardFile } from '@adrive/shared';
import { flushSync } from 'svelte';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { listFiles, type FileListPayload } from './api';
import { setupFileList } from './file-list.fixture.svelte';

vi.mock('./api', () => ({
	getContentLink: vi.fn(),
	listFiles: vi.fn(),
	searchFiles: vi.fn()
}));

const file = (id: string, deletedAt: string | null = null): DashboardFile => ({
	id,
	displayName: `${id}.txt`,
	contentType: 'text/plain',
	kind: 'file',
	version: 1,
	sizeBytes: 6,
	public: true,
	htmlForcedPublic: false,
	createdAt: '2026-08-24T12:00:00.000Z',
	updatedAt: '2026-08-24T12:00:00.000Z',
	deletedAt,
	expiresAt: null,
	downloadCount: 0,
	lastDownloadAt: null,
	indexState: 'pending',
	indexedVersion: null,
	indexAttempts: 0,
	indexError: null,
	tags: []
});

const listing = (files: ReadonlyArray<DashboardFile>): FileListPayload => ({
	files,
	nextCursor: null,
	tags: [],
	contentOrigin: 'https://files.example',
	maxUploadBytes: 1_024,
	semantic: {
		enabled: false,
		indexedChunks: 0,
		dimensions: 384,
		model: '',
		costNotice: ''
	}
});

beforeEach(() => {
	vi.mocked(listFiles).mockReset();
});

describe('createFileList view transitions', () => {
	it('hides active files immediately while the trash listing loads', async () => {
		const active = listing([file('active')]);
		const trash = listing([]);
		const pending = Promise.withResolvers<FileListPayload>();
		vi.mocked(listFiles).mockReturnValueOnce(pending.promise);
		const { files, dispose, setTrash } = setupFileList(active);

		try {
			await vi.waitFor(() => expect(files.list.loading).toBe(false));
			expect(files.visibleFiles.map((entry) => entry.id)).toEqual(['active']);

			flushSync(() => setTrash(true));

			expect(listFiles).toHaveBeenCalledWith(
				'secret-token',
				true,
				expect.any(AbortSignal),
				undefined
			);
			expect(files.visibleFiles).toEqual([]);
			expect(files.currentFiles).toEqual([]);
			expect(files.initialListLoading).toBe(true);

			pending.resolve(trash);
			await vi.waitFor(() => expect(files.list.loading).toBe(false));
			expect(files.visibleFiles).toEqual([]);
			expect(files.initialListLoading).toBe(false);
		} finally {
			pending.resolve(trash);
			dispose();
		}
	});

	it('hides trashed files immediately while the active listing loads', async () => {
		const trashed = file('trashed', '2026-08-24T13:00:00.000Z');
		const trash = listing([trashed]);
		const active = listing([file('active')]);
		const pending = Promise.withResolvers<FileListPayload>();
		vi.mocked(listFiles).mockReturnValueOnce(pending.promise);
		const { files, dispose, setTrash } = setupFileList(trash, true);

		try {
			await vi.waitFor(() => expect(files.list.loading).toBe(false));
			expect(files.visibleFiles.map((entry) => entry.id)).toEqual(['trashed']);

			flushSync(() => setTrash(false));

			expect(files.visibleFiles).toEqual([]);
			expect(files.currentFiles).toEqual([]);
			expect(files.initialListLoading).toBe(true);

			pending.resolve(active);
			await vi.waitFor(() => expect(files.list.loading).toBe(false));
			expect(files.visibleFiles.map((entry) => entry.id)).toEqual(['active']);
			expect(files.initialListLoading).toBe(false);
		} finally {
			pending.resolve(active);
			dispose();
		}
	});

	it('ignores a stale trash response after returning to active files', async () => {
		const initial = listing([file('initial')]);
		const active = listing([file('updated')]);
		const trash = listing([file('trashed', '2026-08-24T13:00:00.000Z')]);
		const pendingTrash = Promise.withResolvers<FileListPayload>();
		const pendingActive = Promise.withResolvers<FileListPayload>();
		vi.mocked(listFiles)
			.mockReturnValueOnce(pendingTrash.promise)
			.mockReturnValueOnce(pendingActive.promise);
		const { files, dispose, setTrash } = setupFileList(initial);

		try {
			await vi.waitFor(() => expect(files.list.loading).toBe(false));
			flushSync(() => setTrash(true));
			flushSync(() => setTrash(false));

			pendingActive.resolve(active);
			await vi.waitFor(() =>
				expect(files.visibleFiles.map((entry) => entry.id)).toEqual(['updated'])
			);

			pendingTrash.resolve(trash);
			await pendingTrash.promise;
			await Promise.resolve();
			flushSync();

			expect(files.list.current.files.map((entry) => entry.id)).toEqual([
				'updated'
			]);
			expect(files.visibleFiles.map((entry) => entry.id)).toEqual(['updated']);
			expect(files.initialListLoading).toBe(false);
		} finally {
			pendingTrash.resolve(trash);
			pendingActive.resolve(active);
			dispose();
		}
	});
});
