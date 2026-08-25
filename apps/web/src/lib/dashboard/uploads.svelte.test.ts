import type { UploadResponse } from '@adrive/shared';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { partitionUploadFiles, UploadManager } from './uploads.svelte';

type UploadFile = typeof import('./api').uploadFile;

const { uploadFileMock } = vi.hoisted(() => ({
	uploadFileMock: vi.fn<UploadFile>()
}));

vi.mock('./api', () => ({
	uploadFile: uploadFileMock,
	uploadFileStaged: vi.fn()
}));

const uploadResponse = {
	file: {
		id: 'file-1',
		displayName: 'report.txt',
		contentType: 'text/plain',
		kind: 'file',
		version: 1,
		sizeBytes: 6,
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
	url: 'https://content.example/file-1',
	forcedPublic: false
} satisfies UploadResponse;

const defaults = {
	token: 'secret-token',
	public: true,
	tags: [],
	expiresAt: null,
	maxUploadBytes: 100_000_000
};

const file = (name = 'report.txt', contents = 'report') =>
	new File([contents], name, { type: 'text/plain' });

beforeEach(() => {
	uploadFileMock.mockReset();
});

describe('upload file limits', () => {
	it('separates oversized files without retaining their File objects', () => {
		const accepted = file('small.txt', 'small');
		const oversized = file('large.txt', 'too large');

		const result = partitionUploadFiles([accepted, oversized], 5);
		const rejection = result.rejected[0];

		expect(result.accepted).toEqual([accepted]);
		expect(result.rejected).toEqual([
			{ name: 'large.txt', size: oversized.size }
		]);
		expect(rejection).toBeDefined();
		if (!rejection) throw new Error('Expected an oversized file');
		expect('file' in rejection).toBe(false);
	});
});

describe('UploadManager', () => {
	it('releases completed files while keeping display metadata', async () => {
		const onComplete = vi.fn();
		uploadFileMock.mockResolvedValue(uploadResponse);
		const uploads = new UploadManager(onComplete);

		uploads.enqueue([file()], defaults);

		await vi.waitFor(() => {
			expect(uploads.items[0]?.status).toBe('done');
		});
		const completed = uploads.items[0];
		expect(completed).toMatchObject({
			name: 'report.txt',
			uploaded: 6,
			total: 6
		});
		if (!completed) throw new Error('Expected a completed upload');
		expect('file' in completed).toBe(false);
		expect(onComplete).toHaveBeenCalledOnce();

		uploads.retry(completed.id);
		await Promise.resolve();
		expect(uploadFileMock).toHaveBeenCalledOnce();

		uploads.removeDone();
		expect(uploads.items).toEqual([]);
	});

	it('retains retryable work after an error and releases it when dismissed', async () => {
		uploadFileMock
			.mockRejectedValueOnce(new Error('Connection lost'))
			.mockResolvedValueOnce(uploadResponse);
		const uploads = new UploadManager(vi.fn());

		uploads.enqueue([file()], defaults);
		await vi.waitFor(() => {
			expect(uploads.items[0]).toMatchObject({
				status: 'error',
				error: 'Connection lost'
			});
		});

		const failed = uploads.items[0];
		if (!failed) throw new Error('Expected a failed upload');
		const id = failed.id;
		uploads.retry(id);
		await vi.waitFor(() => {
			expect(uploads.items[0]?.status).toBe('done');
		});
		expect(uploadFileMock).toHaveBeenCalledTimes(2);

		uploadFileMock.mockRejectedValueOnce(new Error('Still offline'));
		uploads.enqueue([file('second.txt')], defaults);
		await vi.waitFor(() => {
			expect(uploads.items[1]?.status).toBe('error');
		});
		const secondFailure = uploads.items[1];
		if (!secondFailure) throw new Error('Expected a second failed upload');
		const failedId = secondFailure.id;
		uploads.remove(failedId);
		uploads.retry(failedId);
		await Promise.resolve();

		expect(uploads.items).toHaveLength(1);
		expect(uploadFileMock).toHaveBeenCalledTimes(3);
	});

	it('cancels and clears every queued or active upload at an auth boundary', async () => {
		const pending = Promise.withResolvers<UploadResponse>();
		const signals: Array<AbortSignal> = [];
		uploadFileMock.mockImplementation(
			(_token, _file, _isPublic, _tagNames, _expiresAt, options) => {
				const signal = options?.signal;
				if (signal) signals.push(signal);
				return pending.promise;
			}
		);
		const uploads = new UploadManager(vi.fn());

		uploads.enqueue(
			[file('one.txt'), file('two.txt'), file('three.txt'), file('four.txt')],
			defaults
		);
		await vi.waitFor(() => {
			expect(uploadFileMock).toHaveBeenCalledTimes(3);
		});

		uploads.cancelAll();

		expect(uploads.items).toEqual([]);
		expect(signals).toHaveLength(3);
		expect(signals.every((signal) => signal.aborted)).toBe(true);

		pending.resolve(uploadResponse);
		await Promise.resolve();
		uploadFileMock.mockResolvedValue(uploadResponse);
		uploads.enqueue([file('new-session.txt')], defaults);
		await vi.waitFor(() => {
			expect(uploads.items[0]?.status).toBe('done');
		});
	});

	it('disposes active work and rejects future enqueues', async () => {
		const pending = Promise.withResolvers<UploadResponse>();
		uploadFileMock.mockReturnValue(pending.promise);
		const uploads = new UploadManager(vi.fn());

		uploads.enqueue([file()], defaults);
		await vi.waitFor(() => {
			expect(uploadFileMock).toHaveBeenCalledOnce();
		});

		uploads.dispose();
		uploads.enqueue([file('ignored.txt')], defaults);

		expect(uploads.items).toEqual([]);
		expect(uploadFileMock).toHaveBeenCalledOnce();
		pending.resolve(uploadResponse);
	});
});
