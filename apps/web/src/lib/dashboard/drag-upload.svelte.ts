import { partitionUploadFiles } from './uploads.svelte';
import type { UploadManager } from './uploads.svelte';
import type { Toasts } from './toast.svelte';

type DragUploadDeps = {
	readonly session: {
		readonly token: string;
		readonly connecting: boolean;
	};
	readonly toasts: Toasts;
	readonly uploads: UploadManager;
	readonly maxUploadBytes: () => number;
	readonly uploadOpen: () => boolean;
	readonly closeUpload: () => void;
};

export const createDragUpload = ({
	session,
	toasts,
	uploads,
	maxUploadBytes,
	uploadOpen,
	closeUpload
}: DragUploadDeps) => {
	let dragging = $state(false);
	let draggingFolder = $state(false);
	let dragDepth = 0;
	let uploadIdentity = '';

	$effect(() => {
		const token = session.token;
		const nextIdentity = session.connecting ? '' : token;
		if (uploadIdentity && uploadIdentity !== nextIdentity) {
			uploads.cancelAll();
			closeUpload();
		}
		uploadIdentity = nextIdentity;
	});

	const containsFiles = (event: DragEvent) =>
		event.dataTransfer?.types.includes('Files') ?? false;
	const containsFolder = (event: DragEvent) =>
		Array.from(event.dataTransfer?.items ?? []).some(
			(item) => item.kind === 'file' && item.webkitGetAsEntry()?.isDirectory
		);
	const resetDrag = () => {
		dragDepth = 0;
		dragging = false;
		draggingFolder = false;
	};
	const queueFiles = (files: FileList) => {
		const selected = Array.from(files);
		if (selected.length === 0 || !available() || uploadOpen()) return;
		if (maxUploadBytes() <= 0) {
			toasts.error(new Error('The upload limit is not available yet'));
			return;
		}
		const { accepted, rejected } = partitionUploadFiles(
			selected,
			maxUploadBytes()
		);
		if (rejected.length > 0) {
			toasts.error(
				new Error(
					`${rejected.length} ${rejected.length === 1 ? 'file exceeds' : 'files exceed'} the upload limit`
				)
			);
		}
		if (accepted.length === 0) return;
		uploads.enqueue(accepted, {
			token: session.token,
			public: true,
			tags: [],
			expiresAt: null
		});
	};
	const onDragEnter = (event: DragEvent) => {
		if (!available() || uploadOpen() || !containsFiles(event)) return;
		event.preventDefault();
		dragDepth += 1;
		dragging = true;
		draggingFolder = containsFolder(event);
	};
	const onDragLeave = (event: DragEvent) => {
		if (!containsFiles(event)) return;
		dragDepth = Math.max(0, dragDepth - 1);
		if (dragDepth === 0) dragging = false;
	};
	const available = () =>
		Boolean(session.token) && !session.connecting && maxUploadBytes() > 0;

	return {
		get dragging() {
			return dragging;
		},
		get draggingFolder() {
			return draggingFolder;
		},
		set draggingFolder(value: boolean) {
			draggingFolder = value;
		},
		containsFiles,
		containsFolder,
		resetDrag,
		queueFiles,
		onDragEnter,
		onDragLeave,
		available
	};
};

export type DragUpload = ReturnType<typeof createDragUpload>;
