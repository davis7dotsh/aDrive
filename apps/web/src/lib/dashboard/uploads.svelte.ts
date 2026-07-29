import type { Tag } from '@adrive/shared';
import { uploadFile } from './api';

export type UploadItem = {
	readonly id: string;
	readonly file: File;
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

export class UploadManager {
	items = $state.raw<ReadonlyArray<UploadItem>>([]);
	#controllers = new Map<string, AbortController>();
	#defaults = new Map<string, UploadDefaults>();
	#active = 0;
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
		const additions = files.map((file) => {
			const item = {
				id: crypto.randomUUID(),
				file,
				status: 'queued',
				uploaded: 0,
				total: file.size
			} satisfies UploadItem;
			this.#defaults.set(item.id, defaults);
			return item;
		});
		this.items = [...this.items, ...additions];
		this.#schedule();
	}

	cancel(id: string) {
		this.#controllers.get(id)?.abort();
		this.#update(id, { status: 'cancelled' });
	}

	retry(id: string) {
		this.#update(id, { status: 'queued', uploaded: 0, error: undefined });
		this.#schedule();
	}

	removeDone() {
		this.items = this.items.filter(
			(item) => item.status !== 'done' && item.status !== 'cancelled'
		);
	}

	#update(id: string, patch: Partial<UploadItem>) {
		this.items = this.items.map((item) =>
			item.id === id ? { ...item, ...patch } : item
		);
	}

	#schedule() {
		while (this.#active < 3) {
			const next = this.items.find((item) => item.status === 'queued');
			if (!next) return;
			this.#active += 1;
			this.#update(next.id, { status: 'uploading' });
			void this.#run(next).finally(() => {
				this.#active -= 1;
				this.#schedule();
			});
		}
	}

	async #run(item: UploadItem) {
		const defaults = this.#defaults.get(item.id);
		if (!defaults) return;
		const controller = new AbortController();
		this.#controllers.set(item.id, controller);
		try {
			const result = await uploadFile(
				defaults.token,
				item.file,
				defaults.public,
				defaults.tags.map((tag) => tag.name),
				defaults.expiresAt,
				{
					signal: controller.signal,
					onProgress: (uploaded, total) =>
						this.#update(item.id, { uploaded, total })
				}
			);
			this.#update(item.id, {
				status: 'done',
				uploaded: item.file.size,
				total: item.file.size,
				forcedPublic: result.forcedPublic
			});
			this.#onComplete();
		} catch (cause) {
			if (controller.signal.aborted) {
				this.#update(item.id, { status: 'cancelled' });
			} else {
				this.#update(item.id, {
					status: 'error',
					error: cause instanceof Error ? cause.message : 'Upload failed'
				});
			}
		} finally {
			this.#controllers.delete(item.id);
		}
	}
}
