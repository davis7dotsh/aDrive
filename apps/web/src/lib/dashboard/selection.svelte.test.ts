import type { DashboardFile } from '@adrive/shared';
import { flushSync } from 'svelte';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mutateFile } from './api';
import { setupSelection } from './selection.fixture.svelte';
import type { Toasts } from './toast.svelte';

const file = (id: string): DashboardFile => ({
	id,
	displayName: `${id}.txt`,
	contentType: 'text/plain',
	kind: 'file',
	version: 1,
	sizeBytes: 6,
	public: true,
	htmlForcedPublic: false,
	createdAt: '2026-07-30T12:00:00.000Z',
	updatedAt: '2026-07-30T12:00:00.000Z',
	deletedAt: null,
	expiresAt: null,
	downloadCount: 0,
	lastDownloadAt: null,
	indexState: 'pending',
	indexedVersion: null,
	indexAttempts: 0,
	indexError: null,
	tags: []
});

type ToastsStub = Pick<Toasts, 'success' | 'error'>;

const toastsStub = (): ToastsStub => ({
	success: vi.fn(),
	error: vi.fn()
});

// The selection effects (prune, view reset) must be active before any
// interaction, so every test settles the initial state with a flush
// inside setupSelection's $effect.root.
const setup = (options?: {
	files?: ReadonlyArray<DashboardFile>;
	visible?: ReadonlyArray<DashboardFile>;
	view?: boolean | (() => boolean);
}) => {
	const toasts = toastsStub();
	const refetch = vi.fn().mockResolvedValue(undefined);
	const { selection, dispose, setView } = setupSelection(
		toasts,
		refetch,
		options
	);
	flushSync();
	return { selection, toasts, refetch, dispose, setView };
};

vi.mock('./api', () => ({
	mutateFile: vi.fn(),
	setFileTags: vi.fn()
}));

beforeEach(() => {
	vi.mocked(mutateFile).mockReset();
});

describe('createSelection', () => {
	it('selects a single file and reports it as selected', () => {
		const files = [file('a'), file('b')];
		const { selection, dispose } = setup({ files });

		try {
			flushSync(() => selection.selectFile(files[1]!, true, false));

			expect(selection.selectedIds).toEqual(['b']);
		} finally {
			dispose();
		}
	});

	it('extends the selection across a shift range in visible order', () => {
		const files = [file('a'), file('b'), file('c'), file('d')];
		const { selection, dispose } = setup({ files });

		try {
			flushSync(() => selection.selectFile(files[0]!, true, false));
			flushSync(() => selection.selectFile(files[2]!, true, true));

			expect(selection.selectedIds).toEqual(['a', 'b', 'c']);
		} finally {
			dispose();
		}
	});

	it('deselects a shift range that was already selected', () => {
		const files = [file('a'), file('b'), file('c')];
		const { selection, dispose } = setup({ files });

		try {
			flushSync(() => selection.selectAllVisible(true));
			flushSync(() => selection.selectFile(files[1]!, false, true));

			expect(selection.selectedIds).toEqual(['a', 'c']);
		} finally {
			dispose();
		}
	});

	it('toggles select-all over the visible subset only', () => {
		const all = [file('a'), file('b'), file('c')];
		const visible = [all[0]!, all[2]!];
		const { selection, dispose } = setup({ files: all, visible });

		try {
			flushSync(() => selection.selectAllVisible(true));
			expect(selection.selectedIds).toEqual(['a', 'c']);

			flushSync(() => selection.selectAllVisible(false));
			expect(selection.selectedIds).toEqual([]);
		} finally {
			dispose();
		}
	});

	it('keeps selections outside the visible subset when selecting all', () => {
		const all = [file('a'), file('b')];
		const visible = [all[1]!];
		const { selection, dispose } = setup({ files: all, visible });

		try {
			// Seed directly: selectFile only acts on visible files by design,
			// and 'a' is deliberately hidden here.
			selection.selectedIds = ['a'];
			flushSync(() => selection.selectAllVisible(true));

			expect(selection.selectedIds).toEqual(['a', 'b']);
		} finally {
			dispose();
		}
	});

	it('prunes ids that no longer exist in the file list', () => {
		const { selection, dispose } = setup({ files: [file('a')] });

		try {
			selection.selectedIds = ['a', 'b'];
			flushSync();

			expect(selection.selectedIds).toEqual(['a']);
		} finally {
			dispose();
		}
	});

	it('clears the selection when the view flips between files and trash', () => {
		const files = [file('a')];
		const { selection, dispose, setView } = setup({ files });

		try {
			flushSync(() => selection.selectFile(files[0]!, true, false));
			expect(selection.selectedIds).toEqual(['a']);

			setView(true);
			flushSync();

			expect(selection.selectedIds).toEqual([]);
		} finally {
			dispose();
		}
	});

	it('keeps failed targets selected after a batch mutation', async () => {
		const files = [file('a'), file('b')];
		const { selection, toasts, refetch, dispose } = setup({ files });
		vi.mocked(mutateFile)
			.mockRejectedValueOnce(new Error('offline'))
			.mockResolvedValueOnce({ file: files[0]!, forcedPublic: false });

		try {
			flushSync(() => selection.selectAllVisible(true));
			await selection.runBatch('Trashed', (target) =>
				mutateFile('secret-token', target.id, { action: 'trash' })
			);
			flushSync();

			expect(refetch).toHaveBeenCalledOnce();
			expect(selection.selectedIds).toEqual(['a']);
			expect(toasts.error).toHaveBeenCalledWith(
				new Error('Trashed failed for 1 file')
			);
			expect(toasts.success).not.toHaveBeenCalled();
		} finally {
			dispose();
		}
	});

	it('reports a successful batch and clears the selection', async () => {
		const files = [file('a'), file('b')];
		const { selection, toasts, dispose } = setup({ files });
		vi.mocked(mutateFile).mockResolvedValue({
			file: files[0]!,
			forcedPublic: false
		});

		try {
			flushSync(() => selection.selectAllVisible(true));
			await selection.runBatch('Trashed', (target) =>
				mutateFile('secret-token', target.id, { action: 'trash' })
			);
			flushSync();

			expect(selection.selectedIds).toEqual([]);
			expect(toasts.success).toHaveBeenCalledWith('Trashed 2 files');
		} finally {
			dispose();
		}
	});
});
