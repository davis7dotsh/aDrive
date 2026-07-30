<script lang="ts">
	import type { Tag } from '@adrive/shared';
	import Icon from '$lib/components/ui/Icon.svelte';
	import TagChip from './TagChip.svelte';

	let {
		tags,
		selectedIds,
		loading = false,
		ontoggle,
		onclear,
		onmanage
	}: {
		tags: ReadonlyArray<Tag>;
		selectedIds: ReadonlyArray<string>;
		loading?: boolean;
		ontoggle: (id: string) => void;
		onclear: () => void;
		onmanage: () => void;
	} = $props();
</script>

{#if loading}
	<div
		class="mt-5 flex animate-pulse items-center gap-2 motion-reduce:animate-none"
		aria-hidden="true"
	>
		<div class="h-7 w-20 rounded-full bg-zinc-100"></div>
		<div class="h-7 w-24 rounded-full bg-zinc-100"></div>
		<div class="h-7 w-16 rounded-full bg-zinc-100"></div>
		<div class="ml-auto h-8 w-20 rounded-md bg-zinc-100"></div>
	</div>
{:else}
	<div class="mt-5 flex flex-wrap items-center gap-2" aria-label="Filter tags">
		{#each tags as tag (tag.id)}
			<TagChip
				{tag}
				count
				selected={selectedIds.includes(tag.id)}
				onclick={() => ontoggle(tag.id)}
			/>
		{/each}
		{#if selectedIds.length > 0}
			<button
				type="button"
				class="rounded-full px-2.5 py-1.5 text-sm font-medium text-zinc-500 hover:bg-zinc-100 hover:text-zinc-900"
				onclick={onclear}>Clear</button
			>
		{/if}
		<button
			type="button"
			class="ml-auto inline-flex items-center gap-1.5 rounded-md px-2 py-1.5 text-sm text-zinc-500 hover:bg-zinc-100 hover:text-zinc-900"
			onclick={onmanage}
		>
			<Icon name="gear" />
			Edit tags
		</button>
	</div>
{/if}
