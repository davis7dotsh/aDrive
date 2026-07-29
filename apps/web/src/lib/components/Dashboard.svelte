<script lang="ts">
	import type { DashboardFile } from '@adrive/shared';
	import { page } from '$app/state';
	import {
		getContentLink,
		listFiles,
		mutateFile,
		searchFiles
	} from '$lib/dashboard/api';
	import { getDashboardSession } from '$lib/dashboard/session.svelte';
	import { getToasts } from '$lib/dashboard/toast.svelte';
	import { UploadManager } from '$lib/dashboard/uploads.svelte';
	import DeviceApproval from './auth/DeviceApproval.svelte';
	import SignIn from './auth/SignIn.svelte';
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

	const emptyList = {
		files: [],
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
	const deviceCode = $derived(page.url.searchParams.get('device') ?? '');
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
			return trashed
				? listFiles(token, true, signal)
				: searchFiles(token, query, selectedTags, signal);
		},
		{ debounce: 200, initialValue: emptyList }
	);
	const uploads = new UploadManager(() => {
		void list.refetch();
	});
	let uploadOpen = $state(false);
	let tagManagerOpen = $state(false);
	let purgeTarget = $state<DashboardFile>();
	let purgeOpen = $state(false);
	let emptyTrashOpen = $state(false);
	let dragging = $state(false);
	let dragDepth = 0;
	let searchInput = $state<HTMLInputElement>();
	const attachSearch: Attachment<HTMLInputElement> = (node) => {
		searchInput = node;
		return () => {
			if (searchInput === node) searchInput = undefined;
		};
	};

	const filteredFiles = $derived.by(() => {
		const query = params.q.trim().toLowerCase();
		const selectedTags = [...params.tags];
		const filtered = list.current.files.filter(
			(file) =>
				(!query ||
					file.displayName.toLowerCase().includes(query) ||
					file.tags.some((tag) => tag.name.toLowerCase().includes(query))) &&
				(selectedTags.length === 0 ||
					file.tags.some((tag) => selectedTags.includes(tag.id)))
		);
		return [...filtered].sort((left, right) => {
			if (params.sort === 'name')
				return left.displayName.localeCompare(right.displayName);
			if (params.sort === 'size') return right.sizeBytes - left.sizeBytes;
			return right.updatedAt.localeCompare(left.updatedAt);
		});
	});

	$effect(() => () => params.cleanup());

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
		if (session.token && !showTrash) uploadOpen = true;
	});

	const clearFilters = () => {
		params.update({ q: '', tags: [] });
	};

	const toggleTag = (id: string) => {
		params.tags = params.tags.includes(id)
			? params.tags.filter((tagId) => tagId !== id)
			: [...params.tags, id];
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

	const openFile = async (file: DashboardFile) => {
		try {
			if (file.public) {
				const path = file.kind === 'site' ? `s/${file.id}/` : `f/${file.id}`;
				window.open(
					`${list.current.contentOrigin}/${path}`,
					'_blank',
					'noopener'
				);
			} else {
				const link = await getContentLink(session.token, file.id);
				download(link.url, file.displayName);
			}
		} catch (cause) {
			toasts.error(cause, 'Could not open the file');
		}
	};

	const linkFor = async (file: DashboardFile) => {
		const path = file.kind === 'site' ? `s/${file.id}/` : `f/${file.id}`;
		const link = file.public
			? { url: `${list.current.contentOrigin}/${path}` }
			: await getContentLink(session.token, file.id);
		return link.url;
	};

	const changeState = async (
		file: DashboardFile,
		action: 'trash' | 'restore'
	) => {
		const previous = list.current;
		list.mutate({
			...previous,
			files: previous.files.filter((candidate) => candidate.id !== file.id)
		});
		try {
			await mutateFile(session.token, file.id, { action });
			if (action === 'trash') {
				toasts.success('Moved to trash', {
					label: 'Undo',
					run: async () => {
						await mutateFile(session.token, file.id, { action: 'restore' });
						await list.refetch();
					}
				});
			} else {
				toasts.success('File restored');
			}
		} catch (cause) {
			list.mutate(previous);
			toasts.error(cause, 'Could not update the file');
		}
	};

	const purgeFiles = async (targets: ReadonlyArray<DashboardFile>) => {
		const previous = list.current;
		list.mutate({
			...previous,
			files: previous.files.filter(
				(candidate) => !targets.some((target) => target.id === candidate.id)
			)
		});
		try {
			await Promise.all(
				targets.map((file) =>
					mutateFile(session.token, file.id, { action: 'purge' })
				)
			);
			toasts.success(
				targets.length === 1
					? 'Permanent deletion started'
					: 'Empty trash started'
			);
			purgeTarget = undefined;
			purgeOpen = false;
			emptyTrashOpen = false;
		} catch (cause) {
			list.mutate(previous);
			toasts.error(cause, 'Could not permanently delete the file');
		}
	};

	const containsFiles = (event: DragEvent) =>
		event.dataTransfer?.types.includes('Files') ?? false;
	const resetDrag = () => {
		dragDepth = 0;
		dragging = false;
	};
	const queueFiles = (files: FileList) => {
		const selected = Array.from(files);
		if (selected.length === 0 || showTrash) return;
		uploads.enqueue(selected, {
			token: session.token,
			public: true,
			tags: [],
			expiresAt: null
		});
	};
	const onDragEnter = (event: DragEvent) => {
		if (!session.token || !containsFiles(event)) return;
		event.preventDefault();
		dragDepth += 1;
		dragging = true;
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
		if (containsFiles(event)) event.preventDefault();
	}}
	ondragleave={onDragLeave}
	ondragend={resetDrag}
	onblur={resetDrag}
	ondrop={(event) => {
		if (!containsFiles(event)) return;
		event.preventDefault();
		resetDrag();
		if (event.dataTransfer?.files) queueFiles(event.dataTransfer.files);
	}}
	onpaste={(event) => {
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

<DropOverlay active={dragging} disabled={showTrash} />

<main class="mx-auto max-w-7xl px-4 py-8 sm:px-6 sm:py-10">
	{#if !session.ready}
		<div class="mx-auto max-w-md animate-pulse py-12">
			<div class="h-5 w-28 rounded bg-zinc-200"></div>
			<div class="mt-4 h-10 rounded bg-zinc-100"></div>
		</div>
	{:else if !session.token}
		<SignIn {session} />
	{:else}
		{#if deviceCode}
			<DeviceApproval token={session.token} code={deviceCode} />
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
				<Button onclick={() => (uploadOpen = true)}>
					<Icon name="plus" />
					Upload
				</Button>
			{:else if filteredFiles.length > 0}
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
				<select
					aria-label="Sort files"
					bind:value={params.sort}
					class="rounded-md border border-zinc-200 bg-white px-2 py-2 text-sm text-zinc-600"
				>
					<option value="updated">Newest</option>
					<option value="name">Name</option>
					<option value="size">Size</option>
				</select>
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
				ontoggle={toggleTag}
				onclear={() => (params.tags = [])}
				onmanage={() => (tagManagerOpen = true)}
			/>
		</section>

		<section class="mt-8">
			<FileGrid
				files={filteredFiles}
				token={session.token}
				contentOrigin={list.current.contentOrigin}
				trashed={showTrash}
				loading={list.loading}
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
				onupload={() => (uploadOpen = true)}
				onclear={clearFilters}
			/>
		</section>
	{/if}
</main>

{#if session.token}
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
		onconfirm={() => (purgeTarget ? purgeFiles([purgeTarget]) : undefined)}
	/>
	<Confirm
		bind:open={emptyTrashOpen}
		title="Empty trash?"
		message={`${filteredFiles.length} ${filteredFiles.length === 1 ? 'file' : 'files'} and all version history will be permanently removed.`}
		confirmLabel="Empty trash"
		onconfirm={() => purgeFiles(filteredFiles)}
	/>
{/if}
