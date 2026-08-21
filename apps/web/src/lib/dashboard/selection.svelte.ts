import type { DashboardFile, FileMutation, Tag } from '@adrive/shared';
import { mutateFile, setFileTags } from './api';
import type { Toasts } from './toast.svelte';

// Structural dependency: the selection engine only raises toasts.
type ToastSink = Pick<Toasts, 'success' | 'error'>;

type SelectionDeps = {
	readonly session: {
		readonly token: string;
	};
	readonly toasts: ToastSink;
	readonly files: () => ReadonlyArray<DashboardFile>;
	readonly visible: () => ReadonlyArray<DashboardFile>;
	readonly view: () => boolean;
	readonly refetch: () => Promise<unknown>;
};

export const createSelection = ({
	session,
	toasts,
	files,
	visible,
	view,
	refetch
}: SelectionDeps) => {
	let selectedIds = $state<ReadonlyArray<string>>([]);
	let lastSelectionIndex = -1;
	let selectionView = false;
	let batchBusy = $state(false);
	let bulkTagId = $state('');

	$effect(() => {
		const nextView = view();
		if (selectionView !== nextView) {
			selectionView = nextView;
			selectedIds = [];
			lastSelectionIndex = -1;
		}
	});

	$effect(() => {
		const available = new Set(files().map((file) => file.id));
		const next = selectedIds.filter((id) => available.has(id));
		if (next.length !== selectedIds.length) selectedIds = next;
	});

	const selectedFiles = $derived(
		files().filter((file) => selectedIds.includes(file.id))
	);

	const selectFile = (
		file: DashboardFile,
		selected: boolean,
		shift: boolean
	) => {
		const index = visible().findIndex((candidate) => candidate.id === file.id);
		if (index < 0) return;
		const ids =
			shift && lastSelectionIndex >= 0
				? visible()
						.slice(
							Math.min(lastSelectionIndex, index),
							Math.max(lastSelectionIndex, index) + 1
						)
						.map((candidate) => candidate.id)
				: [file.id];
		const next = new Set(selectedIds);
		for (const id of ids) {
			if (selected) next.add(id);
			else next.delete(id);
		}
		selectedIds = [...next];
		lastSelectionIndex = index;
	};

	const selectAllVisible = (selected: boolean) => {
		const visibleIds = new Set(visible().map((file) => file.id));
		selectedIds = selected
			? [...new Set([...selectedIds, ...visibleIds])]
			: selectedIds.filter((id) => !visibleIds.has(id));
		lastSelectionIndex = -1;
	};

	const clear = () => {
		selectedIds = [];
	};

	const runBatch = async (
		label: string,
		operation: (file: DashboardFile) => Promise<unknown>
	) => {
		const targets = selectedFiles;
		if (batchBusy || targets.length === 0) return;
		const token = session.token;
		batchBusy = true;
		try {
			const outcomes = await Promise.allSettled(targets.map(operation));
			await refetch();
			if (session.token !== token) return;
			const failedIds = targets
				.filter((_, index) => outcomes[index]?.status === 'rejected')
				.map((file) => file.id);
			selectedIds = failedIds;
			if (failedIds.length > 0) {
				toasts.error(
					new Error(
						`${label} failed for ${failedIds.length} ${failedIds.length === 1 ? 'file' : 'files'}`
					)
				);
			} else {
				toasts.success(
					`${label} ${targets.length} ${targets.length === 1 ? 'file' : 'files'}`
				);
			}
		} finally {
			batchBusy = false;
		}
	};

	const mutateSelected = (label: string, mutation: FileMutation) =>
		runBatch(label, (file) => mutateFile(session.token, file.id, mutation));

	const addSelectedTag = async (tag: Tag) => {
		await runBatch('Tagged', (file) =>
			setFileTags(
				session.token,
				file.id,
				file.tags.some((current) => current.id === tag.id)
					? file.tags
					: [...file.tags, tag]
			)
		);
		bulkTagId = '';
	};

	return {
		get selectedIds() {
			return selectedIds;
		},
		set selectedIds(value: ReadonlyArray<string>) {
			selectedIds = value;
		},
		get batchBusy() {
			return batchBusy;
		},
		get bulkTagId() {
			return bulkTagId;
		},
		set bulkTagId(value: string) {
			bulkTagId = value;
		},
		selectedFiles,
		selectFile,
		selectAllVisible,
		clear,
		runBatch,
		mutateSelected,
		addSelectedTag
	};
};

export type Selection = ReturnType<typeof createSelection>;
