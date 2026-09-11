import type { DashboardFile } from '@adrive/shared';
import { flushSync, mount, unmount } from 'svelte';
import { SvelteMap } from 'svelte/reactivity';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getContentLink, getFilePreview } from '$lib/dashboard/api';
import FileCardStack from './FileCardStack.svelte';

vi.mock('$lib/dashboard/api', () => ({
	getContentLink: vi.fn(),
	getFilePreview: vi.fn()
}));
vi.mock('$lib/dashboard/toast.svelte', () => ({
	getToasts: () => ({ success: vi.fn(), error: vi.fn() })
}));
vi.mock('runed', async (importOriginal) => ({
	...(await importOriginal<typeof import('runed')>()),
	// These are viewport-visible cards; exercise the real preview resource.
	useIntersectionObserver: (
		_target: unknown,
		callback: (entries: Array<{ isIntersecting: boolean }>) => void
	) => callback([{ isIntersecting: true }])
}));

const file = (overrides: Partial<DashboardFile> = {}): DashboardFile => ({
	id: 'moderated-file',
	displayName: 'review.txt',
	contentType: 'text/plain',
	kind: 'file',
	version: 1,
	sizeBytes: 6,
	public: false,
	quarantined: false,
	publishPending: false,
	htmlForcedPublic: false,
	createdAt: '2026-09-11T12:00:00.000Z',
	updatedAt: '2026-09-11T12:00:00.000Z',
	deletedAt: null,
	expiresAt: null,
	downloadCount: 0,
	lastDownloadAt: null,
	indexState: 'pending',
	indexedVersion: null,
	indexAttempts: 0,
	indexError: null,
	tags: [],
	...overrides
});

const render = (initial: DashboardFile) => {
	const current = new SvelteMap([['file', initial]]);
	const target = document.createElement('div');
	document.body.appendChild(target);
	const component = mount(FileCardStack, {
		target,
		props: {
			get file() {
				return current.get('file') ?? initial;
			},
			token: 'test-token',
			contentOrigin: 'https://tenant.content.test',
			trashed: false,
			returnQuery: '',
			onopen: vi.fn(),
			oncopy: () => '',
			ontrash: vi.fn(),
			onrestore: vi.fn()
		}
	});
	flushSync();
	return {
		target,
		setFile: (next: DashboardFile) =>
			flushSync(() => current.set('file', next)),
		cleanup: async () => {
			await unmount(component);
			target.remove();
		}
	};
};

beforeEach(() => {
	vi.mocked(getContentLink).mockReset();
	vi.mocked(getFilePreview)
		.mockReset()
		.mockResolvedValue({ kind: 'text', text: 'Owner preview' });
});

describe('Sage moderation states', () => {
	it('shows quarantine before other statuses and never starts a preview request', async () => {
		const { target, cleanup } = render(
			file({ quarantined: true, publishPending: true, public: true })
		);
		try {
			expect(target.querySelector('p')?.textContent).toContain('Quarantined');
			expect(target.querySelector('p')?.textContent).not.toContain(
				'Pending review'
			);
			expect(target.querySelector('.stack .thumb')).not.toBeNull();
			expect(target.querySelector('.stack pre, .stack img')).toBeNull();
			await Promise.resolve();
			expect(getFilePreview).not.toHaveBeenCalled();
			expect(getContentLink).not.toHaveBeenCalled();
			const open = Array.from(target.querySelectorAll('button')).find(
				(button) => button.textContent?.trim() === 'Open'
			);
			expect(open?.disabled).toBe(true);
			expect(
				target.querySelector('a[href="/files/moderated-file"]')
			).not.toBeNull();
		} finally {
			await cleanup();
		}
	});

	it('labels a held publication while preserving the owner preview', async () => {
		const { target, cleanup } = render(file({ publishPending: true }));
		try {
			expect(target.querySelector('p')?.textContent).toContain(
				'Pending review'
			);
			await vi.waitFor(() =>
				expect(target.querySelector('.stack pre')?.textContent).toBe(
					'Owner preview'
				)
			);
			expect(getFilePreview).toHaveBeenCalledOnce();
		} finally {
			await cleanup();
		}
	});

	it('removes an already-loaded preview when the same file becomes quarantined', async () => {
		const original = file();
		const { target, setFile, cleanup } = render(original);
		try {
			await vi.waitFor(() =>
				expect(target.querySelector('.stack pre')?.textContent).toBe(
					'Owner preview'
				)
			);
			setFile({ ...original, quarantined: true });
			expect(target.querySelector('p')?.textContent).toContain('Quarantined');
			expect(target.querySelector('.stack pre, .stack img')).toBeNull();
			expect(getFilePreview).toHaveBeenCalledOnce();
		} finally {
			await cleanup();
		}
	});
});
