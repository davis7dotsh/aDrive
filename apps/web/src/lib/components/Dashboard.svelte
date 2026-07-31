<script lang="ts">
	import type { DashboardFile, FileMutation, Tag } from '@adrive/shared';
	import { page } from '$app/state';
	import {
		emptyTrash,
		getContentLink,
		listFiles,
		mutateFile,
		searchFiles,
		setFileTags
	} from '$lib/dashboard/api';
	import { getDashboardSession } from '$lib/dashboard/session.svelte';
	import { getToasts } from '$lib/dashboard/toast.svelte';
	import {
		partitionUploadFiles,
		UploadManager
	} from '$lib/dashboard/uploads.svelte';
	import DeviceApproval from './auth/DeviceApproval.svelte';
	import SignIn from './auth/SignIn.svelte';
	import DashboardSkeleton from './DashboardSkeleton.svelte';
	import Button from './ui/Button.svelte';
	import Confirm from './ui/Confirm.svelte';
	import Icon from './ui/Icon.svelte';
	import FileGrid from './files/FileGrid.svelte';
	import TagFilterBar from './tags/TagFilterBar.svelte';
	import TagManager from './tags/TagManager.svelte';
	import DropOverlay from './upload/DropOverlay.svelte';
	import UploadDialog from './upload/UploadDialog.svelte';
	import UploadQueue from './upload/UploadQueue.svelte';
	import { PressedKeys, resource } from 'runed';
	import { createSearchParamsSchema, useSearchParams } from 'runed/kit';
	import type { Attachment } from 'svelte/attachments';
	import type { FileListPayload } from '$lib/dashboard/api';
	import { untrack } from 'svelte';

	let {
		initialList = null,
		initialError = ''
	}: {
		initialList?: FileListPayload | null;
		initialError?: string;
	} = $props();

	const emptyList = {
		files: [],
		nextCursor: null,
		tags: [],
		contentOrigin: '',
		maxUploadBytes: 0,
		semantic: {
			enabled: false,
			indexedChunks: 0,
			dimensions: 0,
			model: '',
			costNotice: ''
		}
	};
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
	const showTrash = $derived(params.view === 'trash');
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
	const list = resource(
		() =>
			[
				session.ready,
				session.token,
				showTrash,
				params.q,
				[...params.tags]
			] as const,
		async (
			[ready, token, trashed, query, selectedTags],
			_previous,
			{ signal }
		) => {
			if (!ready || !token) return emptyList;
			// Plain browsing pages through /api/files; queries and tag filters
			// go to search, whose results are relevance-bounded, not paginated.
			return trashed
				? listFiles(token, true, signal)
				: query.trim() || selectedTags.length > 0
					? searchFiles(token, query, selectedTags, signal)
					: listFiles(token, false, signal);
		},
		{
			debounce: 200,
			initialValue: untrack(() => initialList) ?? emptyList
		}
	);
	let serverLoadError = $state(untrack(() => initialError));
	const listError = $derived(list.error?.message ?? serverLoadError);
	const initialListLoading = $derived(
		!list.current.contentOrigin && !listError
	);
	const uploads = new UploadManager(() => {
		void list.refetch();
	});
	let loadingMore = $state(false);

	const loadMore = async () => {
		const token = session.token;
		const cursor = list.current.nextCursor;
		if (!token || !cursor || loadingMore) return;
		loadingMore = true;
		try {
			const next = await listFiles(token, showTrash, undefined, cursor);
			if (session.token !== token || list.current.nextCursor !== cursor) {
				return;
			}
			const seen = new Set(list.current.files.map((file) => file.id));
			list.mutate({
				...next,
				files: [
					...list.current.files,
					...next.files.filter((file) => !seen.has(file.id))
				]
			});
		} catch (cause) {
			toasts.error(cause, 'Could not load more files');
		} finally {
			loadingMore = false;
		}
	};
	let uploadOpen = $state(false);
	let tagManagerOpen = $state(false);
	let purgeTarget = $state<DashboardFile>();
	let purgeOpen = $state(false);
	let emptyTrashOpen = $state(false);
	let bulkPurgeOpen = $state(false);
	let purging = $state(false);
	let batchBusy = $state(false);
	let selectedIds = $state<ReadonlyArray<string>>([]);
	let bulkTagId = $state('');
	let lastSelectionIndex = -1;
	let selectionView = false;
	let dragging = $state(false);
	let draggingFolder = $state(false);
	let dragDepth = 0;
	let uploadIdentity = '';
	let searchInput = $state<HTMLInputElement>();
	const attachSearch: Attachment<HTMLInputElement> = (node) => {
		searchInput = node;
		return () => {
			if (searchInput === node) searchInput = undefined;
		};
	};

	const visibleFiles = $derived.by(() => {
		const query = params.q.trim().toLowerCase();
		const selectedTags = [...params.tags];
		if (!showTrash && query) return list.current.files;
		const filtered = showTrash
			? list.current.files.filter(
					(file) =>
						(!query ||
							file.displayName.toLowerCase().includes(query) ||
							file.tags.some((tag) =>
								tag.name.toLowerCase().includes(query)
							)) &&
						(selectedTags.length === 0 ||
							file.tags.some((tag) => selectedTags.includes(tag.id)))
				)
			: list.current.files;
		return [...filtered].sort((left, right) => {
			if (params.sort === 'name')
				return left.displayName.localeCompare(right.displayName);
			if (params.sort === 'size') return right.sizeBytes - left.sizeBytes;
			return right.updatedAt.localeCompare(left.updatedAt);
		});
	});
	const uploadsAvailable = $derived(
		Boolean(session.token) &&
			!session.connecting &&
			!showTrash &&
			list.current.maxUploadBytes > 0
	);

	$effect(() => {
		if (list.current.contentOrigin) serverLoadError = '';
	});

	$effect(() => {
		const nextView = showTrash;
		if (selectionView !== nextView) {
			selectionView = nextView;
			selectedIds = [];
			lastSelectionIndex = -1;
		}
	});

	$effect(() => {
		const available = new Set(list.current.files.map((file) => file.id));
		const next = selectedIds.filter((id) => available.has(id));
		if (next.length !== selectedIds.length) selectedIds = next;
	});

	$effect(() => {
		const token = session.token;
		const nextIdentity = session.connecting ? '' : token;
		if (uploadIdentity && uploadIdentity !== nextIdentity) {
			uploads.cancelAll();
			uploadOpen = false;
		}
		uploadIdentity = nextIdentity;
	});

	$effect(() => () => {
		params.cleanup();
		uploads.dispose();
	});

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
		if (uploadsAvailable) uploadOpen = true;
	});

	const clearFilters = () => {
		params.update({ q: '', tags: [] });
	};

	const toggleTag = (id: string) => {
		params.tags = params.tags.includes(id)
			? params.tags.filter((tagId) => tagId !== id)
			: [...params.tags, id];
	};

	const selectedFiles = $derived(
		list.current.files.filter((file) => selectedIds.includes(file.id))
	);

	const selectFile = (
		file: DashboardFile,
		selected: boolean,
		shift: boolean
	) => {
		const index = visibleFiles.findIndex(
			(candidate) => candidate.id === file.id
		);
		if (index < 0) return;
		const ids =
			shift && lastSelectionIndex >= 0
				? visibleFiles
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
		const visibleIds = new Set(visibleFiles.map((file) => file.id));
		selectedIds = selected
			? [...new Set([...selectedIds, ...visibleIds])]
			: selectedIds.filter((id) => !visibleIds.has(id));
		lastSelectionIndex = -1;
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
			await list.refetch();
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

	const download = (url: string, name: string) => {
		const anchor = document.createElement('a');
		anchor.href = url;
		anchor.download = name;
		anchor.rel = 'noopener';
		document.body.appendChild(anchor);
		anchor.click();
		anchor.remove();
	};

	const isUnavailable = (file: DashboardFile) => {
		const expirationTime = file.expiresAt
			? new Date(file.expiresAt).getTime()
			: Number.NaN;
		return (
			file.deletedAt !== null ||
			(Number.isFinite(expirationTime) && expirationTime <= Date.now())
		);
	};

	const resolveFileLink = async (file: DashboardFile) => {
		const unavailable = isUnavailable(file);
		if (file.public && !unavailable) {
			const path = file.kind === 'site' ? `s/${file.id}/` : `f/${file.id}`;
			return `${list.current.contentOrigin}/${path}`;
		}
		return (
			await getContentLink(
				session.token,
				file.id,
				undefined,
				undefined,
				unavailable
			)
		).url;
	};

	const openFile = async (file: DashboardFile) => {
		try {
			const url = await resolveFileLink(file);
			if (file.public) {
				window.open(url, '_blank', 'noopener');
			} else {
				download(url, file.displayName);
			}
		} catch (cause) {
			toasts.error(cause, 'Could not open the file');
		}
	};

	const linkFor = (file: DashboardFile) => resolveFileLink(file);

	const changeState = async (
		file: DashboardFile,
		action: 'trash' | 'restore'
	) => {
		const token = session.token;
		try {
			await mutateFile(token, file.id, { action });
			if (session.token !== token) return;
			list.mutate({
				...list.current,
				files: list.current.files.filter(
					(candidate) => candidate.id !== file.id
				)
			});
			if (action === 'trash') {
				toasts.success('Moved to trash', {
					label: 'Undo',
					run: async () => {
						await mutateFile(token, file.id, { action: 'restore' });
						await list.refetch();
					}
				});
			} else {
				toasts.success('File restored');
			}
		} catch (cause) {
			if (session.token === token) {
				toasts.error(cause, 'Could not update the file');
			}
		}
	};

	const purgeFiles = async (targets: ReadonlyArray<DashboardFile>) => {
		if (purging || targets.length === 0) return;
		const token = session.token;
		purging = true;
		try {
			const outcomes = await Promise.allSettled(
				targets.map((file) => mutateFile(token, file.id, { action: 'purge' }))
			);
			await list.refetch();
			if (session.token !== token) return;
			const failed = outcomes.filter(
				(outcome) => outcome.status === 'rejected'
			).length;
			if (failed > 0) {
				toasts.error(
					new Error(
						`${failed} ${failed === 1 ? 'file was' : 'files were'} not deleted`
					)
				);
			} else {
				toasts.success(
					targets.length === 1
						? 'Permanent deletion started'
						: 'Empty trash started'
				);
				purgeTarget = undefined;
				purgeOpen = false;
				emptyTrashOpen = false;
				bulkPurgeOpen = false;
			}
		} finally {
			purging = false;
		}
	};

	const purgeAllTrash = async () => {
		if (purging) return;
		const token = session.token;
		purging = true;
		try {
			await emptyTrash(token);
			await list.refetch();
			if (session.token !== token) return;
			selectedIds = [];
			emptyTrashOpen = false;
			toasts.success('Empty trash started');
		} catch (cause) {
			if (session.token === token) {
				toasts.error(cause, 'Could not empty trash');
			}
		} finally {
			purging = false;
		}
	};

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
		if (selected.length === 0 || !uploadsAvailable || uploadOpen) return;
		if (list.current.maxUploadBytes <= 0) {
			toasts.error(new Error('The upload limit is not available yet'));
			return;
		}
		const { accepted, rejected } = partitionUploadFiles(
			selected,
			list.current.maxUploadBytes
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
		if (!uploadsAvailable || uploadOpen || !containsFiles(event)) return;
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
</script>

<svelte:window
	ondragenter={onDragEnter}
	ondragover={(event) => {
		if (containsFiles(event)) {
			event.preventDefault();
			if (uploadsAvailable && !uploadOpen) {
				draggingFolder = containsFolder(event);
			}
		}
	}}
	ondragleave={onDragLeave}
	ondragend={resetDrag}
	onblur={resetDrag}
	ondrop={(event) => {
		if (!containsFiles(event)) return;
		event.preventDefault();
		resetDrag();
		if (uploadOpen || !uploadsAvailable) return;
		const folder = containsFolder(event);
		if (folder) {
			toasts.error(
				new Error(
					'Folders are not uploaded as files. Use `adrive site put` for a site directory.'
				)
			);
			return;
		}
		if (event.dataTransfer?.files) queueFiles(event.dataTransfer.files);
	}}
	onpaste={(event) => {
		if (uploadOpen || !uploadsAvailable) return;
		const files = event.clipboardData?.files;
		if (files?.length) {
			event.preventDefault();
			queueFiles(files);
		}
	}}
	onkeydown={(event) => {
		if (event.key === 'Escape') resetDrag();
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
	active={dragging}
	disabled={!uploadsAvailable || uploadOpen}
	message={draggingFolder ? 'Use `adrive site put` for folders' : undefined}
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

		<header class="flex items-center justify-between gap-4">
			<div class="inline-flex rounded-lg bg-zinc-100 p-1">
				<button
					type="button"
					aria-pressed={!showTrash}
					class="rounded-md px-3 py-1.5 text-sm font-medium {!showTrash
						? 'bg-white text-zinc-950 shadow-sm'
						: 'text-zinc-500'}"
					onclick={() => (params.view = 'files')}>Files</button
				>
				<button
					type="button"
					aria-pressed={showTrash}
					class="rounded-md px-3 py-1.5 text-sm font-medium {showTrash
						? 'bg-white text-zinc-950 shadow-sm'
						: 'text-zinc-500'}"
					onclick={() => (params.view = 'trash')}>Trash</button
				>
			</div>
			{#if !showTrash}
				<Button
					disabled={!uploadsAvailable}
					onclick={() => (uploadOpen = true)}
				>
					<Icon name="plus" />
					Upload
				</Button>
			{:else if list.current.files.length > 0}
				<Button variant="danger" onclick={() => (emptyTrashOpen = true)}>
					Empty trash
				</Button>
			{/if}
		</header>

		<section class="mt-7">
			<div class="flex flex-wrap items-center gap-2">
				<div class="relative min-w-[16rem] flex-1">
					<Icon
						name="search"
						class="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-zinc-400"
					/>
					<label for="drive-search" class="sr-only">Search files</label>
					<input
						{@attach attachSearch}
						id="drive-search"
						type="search"
						bind:value={params.q}
						placeholder={showTrash ? 'Search trash' : 'Search files'}
						class="w-full rounded-lg bg-zinc-100 py-2.5 pr-14 pl-10 text-sm outline-none focus:bg-white focus:ring-2 focus:ring-accent-500"
					/>
					<span
						class="absolute top-1/2 right-3 -translate-y-1/2 text-[10px] text-zinc-400"
					>
						⌘K
					</span>
				</div>
				{#if params.q.trim()}
					<span
						class="rounded-md border border-zinc-200 bg-white px-3 py-2 text-sm text-zinc-500"
					>
						Relevance
					</span>
				{:else}
					<select
						aria-label="Sort files"
						bind:value={params.sort}
						class="rounded-md border border-zinc-200 bg-white px-2 py-2 text-sm text-zinc-600"
					>
						<option value="updated">Newest</option>
						<option value="name">Name</option>
						<option value="size">Size</option>
					</select>
				{/if}
				<div class="inline-flex rounded-md border border-zinc-200 p-0.5">
					<button
						type="button"
						aria-label="Grid view"
						aria-pressed={layout === 'grid'}
						class="rounded px-2 py-1 text-xs {layout === 'grid'
							? 'bg-zinc-100 text-zinc-900'
							: 'text-zinc-400'}"
						onclick={() => (params.layout = 'grid')}>Grid</button
					>
					<button
						type="button"
						aria-label="List view"
						aria-pressed={layout === 'list'}
						class="rounded px-2 py-1 text-xs {layout === 'list'
							? 'bg-zinc-100 text-zinc-900'
							: 'text-zinc-400'}"
						onclick={() => (params.layout = 'list')}>List</button
					>
				</div>
			</div>
			<TagFilterBar
				tags={list.current.tags}
				selectedIds={params.tags}
				loading={initialListLoading}
				ontoggle={toggleTag}
				onclear={() => (params.tags = [])}
				onmanage={() => (tagManagerOpen = true)}
			/>
		</section>

		{#if selectedFiles.length > 0}
			<div
				class="mt-5 flex flex-wrap items-center gap-2 border-y border-zinc-200 py-3"
				aria-label="Selected file actions"
			>
				<p class="mr-auto text-sm font-medium text-zinc-800">
					{selectedFiles.length} selected
				</p>
				{#if showTrash}
					<Button
						variant="secondary"
						disabled={batchBusy}
						onclick={() =>
							void mutateSelected('Restored', { action: 'restore' })}
						>Restore</Button
					>
					<Button
						variant="danger"
						disabled={batchBusy}
						onclick={() => (bulkPurgeOpen = true)}>Delete permanently</Button
					>
				{:else}
					<select
						aria-label="Add tag to selected files"
						bind:value={bulkTagId}
						disabled={batchBusy}
						class="rounded-md border border-zinc-200 bg-white px-2 py-2 text-sm text-zinc-600"
						onchange={() => {
							const tag = list.current.tags.find(
								(candidate) => candidate.id === bulkTagId
							);
							if (tag) void addSelectedTag(tag);
						}}
					>
						<option value="">Add tag…</option>
						{#each list.current.tags as tag (tag.id)}
							<option value={tag.id}>{tag.name}</option>
						{/each}
					</select>
					<Button
						variant="secondary"
						disabled={batchBusy}
						onclick={() =>
							void mutateSelected('Made public', {
								action: 'visibility',
								public: true
							})}>Public</Button
					>
					<Button
						variant="secondary"
						disabled={batchBusy}
						onclick={() =>
							void mutateSelected('Made private', {
								action: 'visibility',
								public: false
							})}>Private</Button
					>
					<Button
						variant="danger"
						disabled={batchBusy}
						onclick={() =>
							void mutateSelected('Moved to trash', { action: 'trash' })}
						>Trash</Button
					>
				{/if}
				<Button
					variant="ghost"
					disabled={batchBusy}
					onclick={() => (selectedIds = [])}>Clear</Button
				>
			</div>
		{/if}

		<section class="mt-8">
			{#if listError}
				<div
					class="mb-5 flex items-center justify-between gap-4 rounded-lg border border-red-200 bg-red-50 px-4 py-3"
					role="alert"
				>
					<p class="text-sm text-red-800">{listError}</p>
					<Button
						variant="secondary"
						disabled={list.loading}
						onclick={() => void list.refetch()}>Try again</Button
					>
				</div>
			{/if}
			<FileGrid
				files={visibleFiles}
				token={session.token}
				contentOrigin={list.current.contentOrigin}
				trashed={showTrash}
				loading={list.loading || initialListLoading}
				queryActive={Boolean(params.q || params.tags.length)}
				returnQuery={page.url.search}
				view={layout}
				actions={{
					open: openFile,
					copy: linkFor,
					trash: (file) => void changeState(file, 'trash'),
					restore: (file) => void changeState(file, 'restore'),
					purge: (file) => {
						purgeTarget = file;
						purgeOpen = true;
					}
				}}
				{selectedIds}
				onselect={selectFile}
				onselectall={selectAllVisible}
				onupload={() => {
					if (uploadsAvailable) uploadOpen = true;
				}}
				onclear={clearFilters}
			/>
			{#if list.current.nextCursor}
				<div class="mt-6 flex justify-center">
					<Button
						variant="secondary"
						disabled={loadingMore}
						onclick={() => void loadMore()}
					>
						{loadingMore ? 'Loading…' : 'Load more'}
					</Button>
				</div>
			{/if}
		</section>
	{/if}
</main>

{#if session.token && !session.connecting}
	<UploadDialog
		bind:open={uploadOpen}
		{uploads}
		token={session.token}
		tags={list.current.tags}
		maxUploadBytes={list.current.maxUploadBytes}
	/>
	<TagManager
		bind:open={tagManagerOpen}
		tags={list.current.tags}
		token={session.token}
		onchanged={() => void list.refetch()}
	/>
	<UploadQueue {uploads} />
	<Confirm
		bind:open={purgeOpen}
		title="Delete permanently?"
		message={`${purgeTarget?.displayName ?? 'This file'} and every version will be removed from storage. This cannot be undone.`}
		confirmLabel="Delete permanently"
		busy={purging}
		onconfirm={() => (purgeTarget ? purgeFiles([purgeTarget]) : undefined)}
	/>
	<Confirm
		bind:open={bulkPurgeOpen}
		title="Delete selected files permanently?"
		message={`${selectedFiles.length} ${selectedFiles.length === 1 ? 'file' : 'files'} and all version history will be removed. This cannot be undone.`}
		confirmLabel="Delete permanently"
		busy={purging}
		onconfirm={() => purgeFiles(selectedFiles)}
	/>
	<Confirm
		bind:open={emptyTrashOpen}
		title="Empty trash?"
		message="Every file in trash and all version history will be permanently removed."
		confirmLabel="Empty trash"
		busy={purging}
		onconfirm={purgeAllTrash}
	/>
{/if}
