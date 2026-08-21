<script lang="ts">
	import type { Attachment } from 'svelte/attachments';
	import Icon from '$lib/components/ui/Icon.svelte';
	import TagFilterBar from '$lib/components/tags/TagFilterBar.svelte';
	import type { Tag } from '@adrive/shared';

	let {
		attachSearch,
		query,
		tags,
		selectedTagIds,
		showTrash,
		layout,
		sort,
		loading,
		onquery,
		ontag,
		onsort,
		onlayout,
		oncleartags,
		onmanagetags
	}: {
		attachSearch?: Attachment<HTMLInputElement>;
		query: string;
		tags: ReadonlyArray<Tag>;
		selectedTagIds: ReadonlyArray<string>;
		showTrash: boolean;
		layout: 'grid' | 'list';
		sort: 'name' | 'size' | 'updated';
		loading: boolean;
		onquery: (value: string) => void;
		ontag: (id: string) => void;
		onsort: (sort: 'name' | 'size' | 'updated') => void;
		onlayout: (layout: 'grid' | 'list') => void;
		oncleartags: () => void;
		onmanagetags: () => void;
	} = $props();
</script>

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
				value={query}
				oninput={(event) => onquery(event.currentTarget.value)}
				placeholder={showTrash ? 'Search trash' : 'Search files'}
				class="w-full rounded-lg bg-zinc-100 py-2.5 pr-14 pl-10 text-sm outline-none focus:bg-white focus:ring-2 focus:ring-accent-500"
			/>
			<span
				class="absolute top-1/2 right-3 -translate-y-1/2 text-[10px] text-zinc-400"
			>
				⌘K
			</span>
		</div>
		{#if query.trim()}
			<span
				class="rounded-md border border-zinc-200 bg-white px-3 py-2 text-sm text-zinc-500"
			>
				Relevance
			</span>
		{:else}
			<select
				aria-label="Sort files"
				value={sort}
				onchange={(event) =>
					onsort(event.currentTarget.value as 'name' | 'size' | 'updated')}
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
				onclick={() => onlayout('grid')}>Grid</button
			>
			<button
				type="button"
				aria-label="List view"
				aria-pressed={layout === 'list'}
				class="rounded px-2 py-1 text-xs {layout === 'list'
					? 'bg-zinc-100 text-zinc-900'
					: 'text-zinc-400'}"
				onclick={() => onlayout('list')}>List</button
			>
		</div>
	</div>
	<TagFilterBar
		{tags}
		selectedIds={selectedTagIds}
		{loading}
		ontoggle={ontag}
		onclear={oncleartags}
		onmanage={onmanagetags}
	/>
</section>
