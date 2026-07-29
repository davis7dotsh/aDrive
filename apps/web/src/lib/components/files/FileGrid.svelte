<script lang="ts">
	import type { DashboardFile } from '@adrive/shared';
	import { formatBytes } from '$lib/dashboard/format';
	import Button from '$lib/components/ui/Button.svelte';
	import FileCard from './FileCard.svelte';
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
		onclear
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
	} = $props();

	const totalSize = $derived(
		files.reduce((sum, file) => sum + file.sizeBytes, 0)
	);
</script>

<div class="flex items-center justify-between border-b border-zinc-200 pb-3">
	<p class="text-sm font-medium text-zinc-700">
		{files.length}
		{files.length === 1 ? 'file' : 'files'}
		{#if files.length > 0}
			<span class="font-normal text-zinc-400">· {formatBytes(totalSize)}</span>
		{/if}
	</p>
	{#if loading}
		<span class="text-xs text-zinc-400">Updating…</span>
	{/if}
</div>

{#if loading && files.length === 0}
	<div
		class="grid grid-cols-2 gap-x-4 gap-y-8 py-6 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6"
	>
		{#each Array(6) as _, index (index)}
			<div class="animate-pulse">
				<div class="aspect-[4/3] rounded-xl bg-zinc-100"></div>
				<div class="mt-3 h-3 w-2/3 rounded bg-zinc-100"></div>
			</div>
		{/each}
	</div>
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
	<FileList {files} {trashed} {returnQuery} {actions} />
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
			/>
		{/each}
	</ul>
{/if}
