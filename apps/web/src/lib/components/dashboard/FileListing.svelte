<script lang="ts">
	import type { DashboardFile } from '@adrive/shared';
	import { page } from '$app/state';
	import Button from '$lib/components/ui/Button.svelte';
	import FileGrid from '$lib/components/files/FileGrid.svelte';

	let {
		files,
		token,
		contentOrigin,
		showTrash,
		initialLoading,
		queryActive,
		layout,
		listError,
		listLoading,
		nextCursor,
		loadingMore,
		selectedIds,
		onselect,
		onselectall,
		onopen,
		oncopy,
		ontrash,
		onrestore,
		onpurge,
		onupload,
		onclearfilters,
		onretry,
		onloadmore
	}: {
		files: ReadonlyArray<DashboardFile>;
		token: string;
		contentOrigin: string;
		showTrash: boolean;
		initialLoading: boolean;
		queryActive: boolean;
		layout: 'grid' | 'list';
		listError?: string;
		listLoading: boolean;
		nextCursor: string | null;
		loadingMore: boolean;
		selectedIds: ReadonlyArray<string>;
		onselect: (file: DashboardFile, selected: boolean, shift: boolean) => void;
		onselectall: (selected: boolean) => void;
		onopen: (file: DashboardFile) => void | Promise<void>;
		oncopy: (file: DashboardFile) => string | Promise<string>;
		ontrash: (file: DashboardFile) => void;
		onrestore: (file: DashboardFile) => void;
		onpurge: (file: DashboardFile) => void;
		onupload: () => void;
		onclearfilters: () => void;
		onretry: () => void;
		onloadmore: () => void;
	} = $props();
</script>

<section class="mt-8">
	{#if listError}
		<div
			class="mb-5 flex items-center justify-between gap-4 rounded-lg border border-red-200 bg-red-50 px-4 py-3"
			role="alert"
		>
			<p class="text-sm text-red-800">{listError}</p>
			<Button variant="secondary" disabled={listLoading} onclick={onretry}>
				Try again
			</Button>
		</div>
	{/if}
	<FileGrid
		{files}
		{token}
		{contentOrigin}
		trashed={showTrash}
		loading={listLoading || initialLoading}
		{queryActive}
		returnQuery={page.url.search}
		view={layout}
		actions={{
			open: onopen,
			copy: oncopy,
			trash: ontrash,
			restore: onrestore,
			purge: onpurge
		}}
		{selectedIds}
		{onselect}
		{onselectall}
		{onupload}
		onclear={onclearfilters}
	/>
	{#if nextCursor}
		<div class="mt-6 flex flex-col items-center gap-2">
			<Button variant="secondary" disabled={loadingMore} onclick={onloadmore}>
				{loadingMore ? 'Loading…' : 'Load more'}
			</Button>
			<p class="text-xs text-zinc-400">
				Not all files are loaded yet — sorting and trash filters apply to the
				files shown so far.
			</p>
		</div>
	{/if}
</section>
