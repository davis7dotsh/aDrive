<script lang="ts">
	import type { Tag } from '@adrive/shared';
	import Icon from '$lib/components/ui/Icon.svelte';
	import TagChip from './TagChip.svelte';

	let {
		tags,
		selectedIds,
		ontoggle,
		onclear,
		onmanage
	}: {
		tags: ReadonlyArray<Tag>;
		selectedIds: ReadonlyArray<string>;
		ontoggle: (id: string) => void;
		onclear: () => void;
		onmanage: () => void;
	} = $props();
</script>

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
