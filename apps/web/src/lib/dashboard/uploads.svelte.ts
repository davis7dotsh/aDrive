import type { Tag } from '@adrive/shared';
import { uploadFile } from './api';

export type UploadItem = {
	readonly id: string;
	readonly name: string;
	readonly status: 'queued' | 'uploading' | 'done' | 'error' | 'cancelled';
	readonly uploaded: number;
	readonly total: number;
	readonly error?: string;
	readonly forcedPublic?: boolean;
};

type UploadDefaults = {
	readonly token: string;
	readonly public: boolean;
	readonly tags: ReadonlyArray<Tag>;
	readonly expiresAt: string | null;
};

type StoredUploadDefaults = Omit<UploadDefaults, 'tags'> & {
	readonly tagNames: ReadonlyArray<string>;
};

export type RejectedUploadFile = {
	readonly name: string;
	readonly size: number;
};

export const partitionUploadFiles = (
	files: ReadonlyArray<File>,
	maxUploadBytes: number
) => {
	const accepted: Array<File> = [];
	const rejected: Array<RejectedUploadFile> = [];

	for (const file of files) {
		if (file.size <= maxUploadBytes) {
			accepted.push(file);
		} else {
			rejected.push({ name: file.name, size: file.size });
		}
	}

	return { accepted, rejected };
};

export class UploadManager {
	items = $state.raw<ReadonlyArray<UploadItem>>([]);
	#controllers = new Map<string, AbortController>();
	#defaults = new Map<string, StoredUploadDefaults>();
	#files = new Map<string, File>();
	#active = 0;
	#disposed = false;
	#onComplete: () => void;

	constructor(onComplete: () => void) {
		this.#onComplete = onComplete;
	}

	get pending() {
		return this.items.filter(
			(item) => item.status === 'queued' || item.status === 'uploading'
		).length;
	}

	enqueue(files: ReadonlyArray<File>, defaults: UploadDefaults) {
		if (this.#disposed) return;

		const additions = files.map((file) => {
			const item = {
				id: crypto.randomUUID(),
				name: file.name,
				status: 'queued',
				uploaded: 0,
				total: file.size
			} satisfies UploadItem;
			this.#files.set(item.id, file);
			this.#defaults.set(item.id, {
				token: defaults.token,
				public: defaults.public,
				tagNames: defaults.tags.map((tag) => tag.name),
				expiresAt: defaults.expiresAt
			});
			return item;
		});
		this.items = [...this.items, ...additions];
		this.#schedule();
	}

	cancel(id: string) {
		const item = this.items.find((candidate) => candidate.id === id);
		if (
			!item ||
			(item.status !== 'queued' &&
				item.status !== 'uploading' &&
				item.status !== 'error')
		) {
			return;
		}

		this.#controllers.get(id)?.abort();
		this.#release(id);
		this.#update(id, { status: 'cancelled', error: undefined });
	}

	retry(id: string) {
		const item = this.items.find((candidate) => candidate.id === id);
		if (
			this.#disposed ||
			item?.status !== 'error' ||
			!this.#files.has(id) ||
			!this.#defaults.has(id)
		) {
			return;
		}

		this.#update(id, { status: 'queued', uploaded: 0, error: undefined });
		this.#schedule();
	}

	remove(id: string) {
		const item = this.items.find((candidate) => candidate.id === id);
		if (!item || item.status === 'queued' || item.status === 'uploading') {
			return;
		}

		this.#release(id);
		this.items = this.items.filter((candidate) => candidate.id !== id);
	}

	removeDone() {
		for (const item of this.items) {
			if (item.status === 'done' || item.status === 'cancelled') {
				this.#release(item.id);
			}
		}
		this.items = this.items.filter(
			(item) => item.status !== 'done' && item.status !== 'cancelled'
		);
	}

	cancelAll() {
		for (const controller of this.#controllers.values()) {
			controller.abort();
		}
		this.#controllers.clear();
		this.#defaults.clear();
		this.#files.clear();
		this.items = [];
	}

	dispose() {
		if (this.#disposed) return;
		this.#disposed = true;
		this.cancelAll();
	}

	#update(id: string, patch: Partial<UploadItem>) {
		this.items = this.items.map((item) =>
			item.id === id ? { ...item, ...patch } : item
		);
	}

	#schedule() {
		if (this.#disposed) return;

		while (this.#active < 3) {
			const next = this.items.find((item) => item.status === 'queued');
			if (!next) return;
			this.#active += 1;
			this.#update(next.id, { status: 'uploading' });
			void this.#run(next.id).finally(() => {
				this.#active -= 1;
				this.#schedule();
			});
		}
	}

	async #run(id: string) {
		const file = this.#files.get(id);
		const defaults = this.#defaults.get(id);
		if (!file || !defaults) {
			this.#update(id, { status: 'cancelled' });
			return;
		}

		const controller = new AbortController();
		this.#controllers.set(id, controller);
		try {
			const result = await uploadFile(
				defaults.token,
				file,
				defaults.public,
				defaults.tagNames,
				defaults.expiresAt,
				{
					signal: controller.signal,
					onProgress: (uploaded, total) => {
						if (
							this.#controllers.get(id) === controller &&
							!controller.signal.aborted
						) {
							this.#update(id, { uploaded, total });
						}
					}
				}
			);
			if (
				this.#disposed ||
				controller.signal.aborted ||
				this.#controllers.get(id) !== controller ||
				this.#files.get(id) !== file ||
				this.#defaults.get(id) !== defaults
			) {
				return;
			}

			this.#release(id);
			this.#update(id, {
				status: 'done',
				uploaded: file.size,
				total: file.size,
				forcedPublic: result.forcedPublic
			});
			this.#onComplete();
		} catch (cause) {
			if (
				this.#disposed ||
				controller.signal.aborted ||
				this.#controllers.get(id) !== controller ||
				this.#files.get(id) !== file ||
				this.#defaults.get(id) !== defaults
			) {
				return;
			}

			this.#update(id, {
				status: 'error',
				error: cause instanceof Error ? cause.message : 'Upload failed'
			});
		} finally {
			if (this.#controllers.get(id) === controller) {
				this.#controllers.delete(id);
			}
		}
	}

	#release(id: string) {
		this.#controllers.delete(id);
		this.#defaults.delete(id);
		this.#files.delete(id);
	}
}
