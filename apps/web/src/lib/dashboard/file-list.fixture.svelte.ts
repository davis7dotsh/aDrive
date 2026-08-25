import { flushSync } from 'svelte';
import type { FileListPayload } from './api';
import { createFileList } from './file-list.svelte';
import { Toasts } from './toast.svelte';

export const setupFileList = (
	initialList: FileListPayload,
	initialTrash = false
) => {
	let trashed = $state(initialTrash);
	let files!: ReturnType<typeof createFileList>;
	const dispose = $effect.root(() => {
		files = createFileList({
			session: { ready: true, token: 'secret-token' },
			toasts: new Toasts(),
			query: () => '',
			tags: () => [],
			trashed: () => trashed,
			sort: () => 'updated',
			initialList
		});
	});
	flushSync();
	return {
		files,
		dispose,
		setTrash: (value: boolean) => {
			trashed = value;
		}
	};
};
