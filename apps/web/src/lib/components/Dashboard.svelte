<script lang="ts">
	import type { DashboardFile } from '@adrive/shared';
	import { browser } from '$app/environment';
	import { page } from '$app/state';
	import type { FileListPayload } from '$lib/dashboard/api';
	import {
		createFileList,
		resolveFileLink
	} from '$lib/dashboard/file-list.svelte';
	import { createDragUpload } from '$lib/dashboard/drag-upload.svelte';
	import { createSelection } from '$lib/dashboard/selection.svelte';
	import { getDashboardSession } from '$lib/dashboard/session.svelte';
	import { getToasts } from '$lib/dashboard/toast.svelte';
	import { createTrashFlows } from '$lib/dashboard/trash-flows.svelte';
	import { UploadManager } from '$lib/dashboard/uploads.svelte';
	import DeviceApproval from './auth/DeviceApproval.svelte';
	import SignIn from './auth/SignIn.svelte';
	import DashboardSkeleton from './DashboardSkeleton.svelte';
	import BulkActionBar from './dashboard/BulkActionBar.svelte';
	import DashboardHeader from './dashboard/DashboardHeader.svelte';
	import FileListing from './dashboard/FileListing.svelte';
	import SearchFilterBar from './dashboard/SearchFilterBar.svelte';
	import Confirm from './ui/Confirm.svelte';
	import TagManager from './tags/TagManager.svelte';
	import DropOverlay from './upload/DropOverlay.svelte';
	import UploadDialog from './upload/UploadDialog.svelte';
	import UploadQueue from './upload/UploadQueue.svelte';
	import { PressedKeys } from 'runed';
	import { createSearchParamsSchema, useSearchParams } from 'runed/kit';
	import { untrack } from 'svelte';
	import type { Attachment } from 'svelte/attachments';

	let {
		initialList = null,
		initialError = ''
	}: {
		initialList?: FileListPayload | null;
		initialError?: string;
	} = $props();

	const searchSchema = createSearchParamsSchema({
		q: { type: 'string', default: '' },
		tags: { type: 'array', default: [], arrayType: '' },
		view: { type: 'string', default: 'files' },
		layout: { type: 'string', default: 'grid' },
		sort: { type: 'string', default: 'updated' }
	});
	const params = useSearchParams(searchSchema, {
		debounce: 200,
		pushHistory: true,
		noScroll: true
	});
	const session = getDashboardSession();
	const toasts = getToasts();
	const showTrash = $derived(
		browser
			? params.view === 'trash'
			: page.url.searchParams.get('view') === 'trash'
	);
	const layout = $derived(params.layout === 'list' ? 'list' : 'grid');
	const loadingLayout = $derived(
		page.url.searchParams.get('layout') === 'list' ? 'list' : 'grid'
	);
	const deviceCode = $derived(page.url.searchParams.get('device') ?? '');
	const deviceExpiresAt = $derived.by(() => {
		const seconds = Number(page.url.searchParams.get('expires'));
		return Number.isSafeInteger(seconds) && seconds > 0
			? seconds * 1_000
			: undefined;
	});

	const files = createFileList({
		session,
		toasts,
		query: () => params.q,
		tags: () => params.tags,
		trashed: () => showTrash,
		sort: () =>
			params.sort === 'name'
				? 'name'
				: params.sort === 'size'
					? 'size'
					: 'updated',
		initialList: untrack(() => initialList),
		initialError: untrack(() => initialError)
	});
	const uploads = new UploadManager(() => {
		void files.list.refetch();
	});
	let uploadOpen = $state(false);
	let tagManagerOpen = $state(false);

	const selection = createSelection({
		session,
		toasts,
		files: () => files.currentFiles,
		visible: () => files.visibleFiles,
		view: () => showTrash,
		refetch: () => files.list.refetch()
	});
	const trash = createTrashFlows({
		session,
		toasts,
		refetch: () => files.list.refetch(),
		clearSelection: selection.clear,
		onRemove: files.removeFile
	});
	const drag = createDragUpload({
		session,
		toasts,
		uploads,
		maxUploadBytes: () => files.list.current.maxUploadBytes,
		uploadOpen: () => uploadOpen,
		closeUpload: () => (uploadOpen = false),
		trashed: () => showTrash
	});

	$effect(() => () => {
		params.cleanup();
		uploads.dispose();
	});

	let searchInput = $state<HTMLInputElement>();
	const attachSearch: Attachment<HTMLInputElement> = (node) => {
		searchInput = node;
		return () => {
			if (searchInput === node) searchInput = undefined;
		};
	};

	const pressed = new PressedKeys();
	pressed.onKeys('/', () => searchInput?.focus());
	pressed.onKeys(['Meta', 'k'], () => searchInput?.focus());
	pressed.onKeys('u', () => {
		if (
			document.activeElement instanceof HTMLInputElement ||
			document.activeElement instanceof HTMLTextAreaElement ||
			document.activeElement instanceof HTMLSelectElement
		)
			return;
		if (drag.available()) uploadOpen = true;
	});

	const clearFilters = () => {
		params.update({ q: '', tags: [] });
	};

	const toggleTag = (id: string) => {
		params.tags = params.tags.includes(id)
			? params.tags.filter((tagId) => tagId !== id)
			: [...params.tags, id];
	};

	const openFile = async (file: DashboardFile) => {
		try {
			const url = await resolveFileLink(
				file,
				session.token,
				files.list.current.contentOrigin
			);
			if (file.public) {
				window.open(url, '_blank', 'noopener');
			} else {
				download(url, file.displayName);
			}
		} catch (cause) {
			toasts.error(cause, 'Could not open the file');
		}
	};

	const download = (url: string, name: string) => {
		const anchor = document.createElement('a');
		anchor.href = url;
		anchor.download = name;
		anchor.rel = 'noopener';
		document.body.appendChild(anchor);
		anchor.click();
		anchor.remove();
	};

	const linkFor = (file: DashboardFile) =>
		resolveFileLink(file, session.token, files.list.current.contentOrigin);

	const addSelectedTag = async (tagId: string) => {
		const tag = files.list.current.tags.find(
			(candidate) => candidate.id === tagId
		);
		if (!tag) return;
		await selection.addSelectedTag(tag);
	};
</script>

<svelte:window
	ondragenter={drag.onDragEnter}
	ondragover={(event) => {
		if (drag.containsFiles(event)) {
			event.preventDefault();
			if (drag.available() && !uploadOpen) {
				drag.draggingFolder = drag.containsFolder(event);
			}
		}
	}}
	ondragleave={drag.onDragLeave}
	ondragend={drag.resetDrag}
	onblur={drag.resetDrag}
	ondrop={(event) => {
		if (!drag.containsFiles(event)) return;
		event.preventDefault();
		drag.resetDrag();
		if (uploadOpen || !drag.available()) return;
		const folder = drag.containsFolder(event);
		if (folder) {
			toasts.error(
				new Error(
					'Folders are not uploaded as files. Use `adrive site put` for a site directory.'
				)
			);
			return;
		}
		if (event.dataTransfer?.files) drag.queueFiles(event.dataTransfer.files);
	}}
	onpaste={(event) => {
		if (uploadOpen || !drag.available()) return;
		const pasted = event.clipboardData?.files;
		if (pasted?.length) {
			event.preventDefault();
			drag.queueFiles(pasted);
		}
	}}
	onkeydown={(event) => {
		if (event.key === 'Escape') drag.resetDrag();
		if (
			event.key === 'Escape' &&
			document.activeElement === searchInput &&
			params.q
		) {
			params.q = '';
		}
	}}
/>

<DropOverlay
	active={drag.dragging}
	disabled={!drag.available() || uploadOpen}
	message={drag.draggingFolder
		? 'Use `adrive site put` for folders'
		: undefined}
/>

<main class="mx-auto max-w-7xl px-4 py-8 sm:px-6 sm:py-10">
	{#if !session.ready}
		<DashboardSkeleton view={loadingLayout} />
	{:else if !session.token}
		<SignIn {session} />
	{:else}
		{#if deviceCode}
			<DeviceApproval
				token={session.token}
				code={deviceCode}
				expiresAt={deviceExpiresAt}
			/>
		{/if}

		<DashboardHeader
			{showTrash}
			filesCount={files.currentFiles.length}
			uploadsAvailable={drag.available()}
			onview={(view) => (params.view = view)}
			onupload={() => (uploadOpen = true)}
			onemptytrash={() => (trash.emptyTrashOpen = true)}
		/>

		<SearchFilterBar
			{attachSearch}
			query={params.q}
			tags={files.list.current.tags}
			selectedTagIds={params.tags}
			{showTrash}
			{layout}
			sort={params.sort === 'name'
				? 'name'
				: params.sort === 'size'
					? 'size'
					: 'updated'}
			loading={files.initialListLoading}
			onquery={(value) => (params.q = value)}
			ontag={toggleTag}
			onsort={(value) => (params.sort = value)}
			onlayout={(value) => (params.layout = value)}
			oncleartags={() => (params.tags = [])}
			onmanagetags={() => (tagManagerOpen = true)}
		/>

		<BulkActionBar
			selectedCount={selection.selectedFiles.length}
			{showTrash}
			tags={files.list.current.tags}
			bulkTagId={selection.bulkTagId}
			batchBusy={selection.batchBusy}
			onbulktag={(tagId) => void addSelectedTag(tagId)}
			onmutate={(label, mutation) =>
				void selection.mutateSelected(label, mutation)}
			onbulkpurge={() => (trash.bulkPurgeOpen = true)}
			onclear={selection.clear}
		/>

		<FileListing
			files={files.visibleFiles}
			token={session.token}
			contentOrigin={files.list.current.contentOrigin}
			{showTrash}
			initialLoading={files.initialListLoading}
			queryActive={Boolean(params.q || params.tags.length)}
			{layout}
			listError={files.listError}
			listLoading={files.list.loading}
			nextCursor={files.initialListLoading
				? null
				: files.list.current.nextCursor}
			loadingMore={files.loadingMore}
			selectedIds={selection.selectedIds}
			onselect={selection.selectFile}
			onselectall={selection.selectAllVisible}
			onopen={(file) => openFile(file)}
			oncopy={linkFor}
			ontrash={(file) => void trash.changeState(file, 'trash')}
			onrestore={(file) => void trash.changeState(file, 'restore')}
			onpurge={trash.openPurge}
			onupload={() => {
				if (drag.available()) uploadOpen = true;
			}}
			onclearfilters={clearFilters}
			onretry={() => void files.list.refetch()}
			onloadmore={() => void files.loadMore(showTrash)}
		/>
	{/if}
</main>

{#if session.token && !session.connecting}
	<UploadDialog
		bind:open={uploadOpen}
		{uploads}
		token={session.token}
		tags={files.list.current.tags}
		maxUploadBytes={files.list.current.maxUploadBytes}
	/>
	<TagManager
		bind:open={tagManagerOpen}
		tags={files.list.current.tags}
		token={session.token}
		onchanged={() => void files.list.refetch()}
	/>
	<UploadQueue {uploads} />
	<Confirm
		bind:open={trash.purgeOpen}
		title="Delete permanently?"
		message={`${trash.purgeTarget?.displayName ?? 'This file'} and every version will be removed from storage. This cannot be undone.`}
		confirmLabel="Delete permanently"
		busy={trash.purging}
		onconfirm={() =>
			trash.purgeTarget ? trash.purgeFiles([trash.purgeTarget]) : undefined}
	/>
	<Confirm
		bind:open={trash.bulkPurgeOpen}
		title="Delete selected files permanently?"
		message={`${selection.selectedFiles.length} ${selection.selectedFiles.length === 1 ? 'file' : 'files'} and all version history will be removed. This cannot be undone.`}
		confirmLabel="Delete permanently"
		busy={trash.purging}
		onconfirm={() => trash.purgeFiles(selection.selectedFiles)}
	/>
	<Confirm
		bind:open={trash.emptyTrashOpen}
		title="Empty trash?"
		message="Every file in trash and all version history will be permanently removed."
		confirmLabel="Empty trash"
		busy={trash.purging}
		onconfirm={trash.purgeAllTrash}
	/>
{/if}
