<script lang="ts">
	import type { Tag } from '@adrive/shared';

	let {
		tag,
		selected = false,
		count = false,
		removable = false,
		onclick,
		onremove
	}: {
		tag: Tag;
		selected?: boolean;
		count?: boolean;
		removable?: boolean;
		onclick?: () => void;
		onremove?: () => void;
	} = $props();
</script>

{#if onclick}
	<button
		type="button"
		aria-pressed={selected}
		class="inline-flex items-center gap-2 rounded-full border px-3 py-1.5 text-sm font-medium transition {selected
			? 'border-accent-500 bg-accent-50 text-accent-700 ring-1 ring-accent-500'
			: 'border-zinc-200 bg-zinc-50 text-zinc-700 hover:border-zinc-300 hover:bg-white'}"
		{onclick}
	>
		<span
			class="size-2.5 shrink-0 rounded-full"
			style:background={tag.color ?? 'var(--color-tag-default)'}
		></span>
		{tag.name}
		{#if count}
			<span class="text-xs font-normal text-zinc-400">{tag.fileCount}</span>
		{/if}
	</button>
{:else}
	<span
		class="inline-flex items-center gap-2 rounded-full border border-zinc-200 bg-zinc-50 px-2.5 py-1 text-xs text-zinc-600"
	>
		<span
			class="size-2 shrink-0 rounded-full"
			style:background={tag.color ?? 'var(--color-tag-default)'}
		></span>
		{tag.name}
		{#if removable}
			<button
				type="button"
				class="-mr-1 rounded-full px-1 text-zinc-400 hover:bg-zinc-200 hover:text-zinc-800"
				aria-label={`Remove ${tag.name}`}
				onclick={onremove}>×</button
			>
		{/if}
	</span>
{/if}
