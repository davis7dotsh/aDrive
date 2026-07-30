<script lang="ts">
	import type { DashboardFile } from '@adrive/shared';
	import { formatBytes } from '$lib/dashboard/format';
	import Button from '$lib/components/ui/Button.svelte';
	import FileCard from './FileCard.svelte';
	import FileGridSkeleton from './FileGridSkeleton.svelte';
	import FileList from './FileList.svelte';

	let {
		files,
		token,
		contentOrigin,
		trashed,
		loading,
		queryActive,
		returnQuery,
		view,
		actions,
		onupload,
		onclear,
		selectedIds = [],
		onselect,
		onselectall
	}: {
		files: ReadonlyArray<DashboardFile>;
		token: string;
		contentOrigin: string;
		trashed: boolean;
		loading: boolean;
		queryActive: boolean;
		returnQuery: string;
		view: 'grid' | 'list';
		actions: {
			open: (file: DashboardFile) => void;
			copy: (file: DashboardFile) => string | Promise<string>;
			trash: (file: DashboardFile) => void;
			restore: (file: DashboardFile) => void;
			purge: (file: DashboardFile) => void;
		};
		onupload: () => void;
		onclear: () => void;
		selectedIds?: ReadonlyArray<string>;
		onselect?: (file: DashboardFile, selected: boolean, shift: boolean) => void;
		onselectall?: (selected: boolean) => void;
	} = $props();

	const totalSize = $derived(
		files.reduce((sum, file) => sum + file.sizeBytes, 0)
	);
	const initialLoading = $derived(loading && files.length === 0);
</script>

<div
	aria-busy={loading}
	aria-live="polite"
	class="flex items-center justify-between border-b border-zinc-200 pb-3"
>
	{#if initialLoading}
		<p class="text-sm font-medium text-zinc-500">Loading files…</p>
	{:else}
		<div class="flex items-center gap-2">
			{#if onselectall && files.length > 0}
				<input
					type="checkbox"
					checked={files.every((file) => selectedIds.includes(file.id))}
					aria-label="Select all visible files"
					class="size-4 rounded border-zinc-300 accent-zinc-950"
					onchange={(event) => onselectall(event.currentTarget.checked)}
				/>
			{/if}
			<p class="text-sm font-medium text-zinc-700">
				{files.length}
				{files.length === 1 ? 'file' : 'files'}
				{#if files.length > 0}
					<span class="font-normal text-zinc-400">
						· {formatBytes(totalSize)}
					</span>
				{/if}
			</p>
		</div>
	{/if}
	{#if loading && !initialLoading}
		<span class="inline-flex items-center gap-1.5 text-xs text-zinc-400">
			<span
				class="size-1.5 animate-pulse rounded-full bg-zinc-400 motion-reduce:animate-none"
			></span>
			Updating
		</span>
	{/if}
</div>

{#if initialLoading}
	<FileGridSkeleton {view} />
{:else if files.length === 0}
	<div class="py-20 text-center">
		<p class="text-sm font-medium text-zinc-700">
			{trashed
				? 'Trash is empty'
				: queryActive
					? 'No matching files'
					: 'No files yet'}
		</p>
		{#if queryActive}
			<Button variant="secondary" class="mt-4" onclick={onclear}>
				Clear search and filters
			</Button>
		{:else if !trashed}
			<Button class="mt-4" onclick={onupload}>Upload files</Button>
			<p class="mt-2 text-xs text-zinc-400">
				or drop them anywhere · ⌘V to paste
			</p>
		{/if}
	</div>
{:else if view === 'list'}
	<FileList
		{files}
		{trashed}
		{returnQuery}
		{actions}
		{selectedIds}
		{onselect}
	/>
{:else}
	<ul
		class="grid grid-cols-2 gap-x-4 gap-y-8 py-6 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6"
	>
		{#each files as file (file.id)}
			<FileCard
				{file}
				{token}
				{contentOrigin}
				{trashed}
				{returnQuery}
				onopen={() => actions.open(file)}
				oncopy={() => actions.copy(file)}
				ontrash={() => actions.trash(file)}
				onrestore={() => actions.restore(file)}
				onpurge={() => actions.purge(file)}
				selected={selectedIds.includes(file.id)}
				onselect={onselect
					? (selected, shift) => onselect(file, selected, shift)
					: undefined}
			/>
		{/each}
	</ul>
{/if}
