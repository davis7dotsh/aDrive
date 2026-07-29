<script lang="ts">
	import type { Tag } from '@adrive/shared';
	import TagChip from './TagChip.svelte';

	let {
		tags,
		selected,
		busy = false,
		ontoggle,
		oncreate
	}: {
		tags: ReadonlyArray<Tag>;
		selected: ReadonlyArray<Tag>;
		busy?: boolean;
		ontoggle: (tag: Tag) => void | Promise<void>;
		oncreate?: (name: string) => void | Promise<void>;
	} = $props();

	let query = $state('');
	const matches = $derived(
		tags.filter((tag) => tag.name.toLowerCase().includes(query.toLowerCase()))
	);
</script>

<div>
	{#if selected.length > 0}
		<div class="mb-2 flex flex-wrap gap-1.5">
			{#each selected as tag (tag.id)}
				<TagChip {tag} removable onremove={() => void ontoggle(tag)} />
			{/each}
		</div>
	{/if}
	<input
		type="search"
		bind:value={query}
		placeholder="Find or create a tag"
		class="w-full rounded-md border border-zinc-300 px-3 py-2 text-sm"
		onkeydown={(event) => {
			if (
				event.key === 'Enter' &&
				query.trim() &&
				matches.length === 0 &&
				oncreate
			) {
				event.preventDefault();
				void oncreate(query.trim());
				query = '';
			}
		}}
	/>
	{#if query || matches.length > 0}
		<div class="mt-2 flex max-h-40 flex-wrap gap-1.5 overflow-y-auto">
			{#each matches as tag (tag.id)}
				<button
					type="button"
					disabled={busy}
					aria-pressed={selected.some((item) => item.id === tag.id)}
					class="rounded-full border px-2.5 py-1 text-xs {selected.some(
						(item) => item.id === tag.id
					)
						? 'border-accent-500 bg-accent-50 text-accent-700'
						: 'border-zinc-200 text-zinc-600'}"
					onclick={() => void ontoggle(tag)}>{tag.name}</button
				>
			{/each}
			{#if query.trim() && matches.length === 0 && oncreate}
				<button
					type="button"
					class="rounded-md px-2.5 py-1 text-xs font-medium text-accent-700 hover:bg-accent-50"
					onclick={() => {
						void oncreate(query.trim());
						query = '';
					}}>Create “{query.trim()}”</button
				>
			{/if}
		</div>
	{/if}
</div>
