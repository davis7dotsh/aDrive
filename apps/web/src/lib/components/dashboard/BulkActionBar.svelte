<script lang="ts">
	import type { FileMutation, Tag } from '@adrive/shared';
	import Button from '$lib/components/ui/Button.svelte';
	import { fly } from 'svelte/transition';

	let {
		selectedCount,
		showTrash,
		tags,
		bulkTagId,
		batchBusy,
		onbulktag,
		onmutate,
		onbulkpurge,
		onclear
	}: {
		selectedCount: number;
		showTrash: boolean;
		tags: ReadonlyArray<Tag>;
		bulkTagId: string;
		batchBusy: boolean;
		onbulktag: (tagId: string) => void;
		onmutate: (label: string, mutation: FileMutation) => void;
		onbulkpurge: () => void;
		onclear: () => void;
	} = $props();
</script>

{#if selectedCount > 0}
	<div
		transition:fly={{ y: 12, duration: 180 }}
		class="bulk-bar fixed right-4 bottom-4 z-30 flex max-w-[calc(100vw-2rem)] flex-wrap items-center gap-2 rounded-xl border border-zinc-200 bg-white p-2 pl-4 shadow-xl sm:right-6 sm:bottom-6"
		aria-label="Selected file actions"
	>
		<p class="mr-2 text-sm font-medium text-zinc-800">
			{selectedCount} selected
		</p>
		{#if showTrash}
			<Button
				variant="secondary"
				disabled={batchBusy}
				onclick={() => onmutate('Restored', { action: 'restore' })}
				>Restore</Button
			>
			<Button variant="danger" disabled={batchBusy} onclick={onbulkpurge}>
				Delete permanently
			</Button>
		{:else}
			<select
				aria-label="Add tag to selected files"
				value={bulkTagId}
				disabled={batchBusy}
				class="rounded-md border border-zinc-200 bg-white px-2 py-2 text-sm text-zinc-600"
				onchange={(event) => onbulktag(event.currentTarget.value)}
			>
				<option value="">Add tag…</option>
				{#each tags as tag (tag.id)}
					<option value={tag.id}>{tag.name}</option>
				{/each}
			</select>
			<Button
				variant="secondary"
				disabled={batchBusy}
				onclick={() =>
					onmutate('Made public', { action: 'visibility', public: true })}
			>
				Public
			</Button>
			<Button
				variant="secondary"
				disabled={batchBusy}
				onclick={() =>
					onmutate('Made private', { action: 'visibility', public: false })}
			>
				Private
			</Button>
			<Button
				variant="danger"
				disabled={batchBusy}
				onclick={() => onmutate('Moved to trash', { action: 'trash' })}
				>Trash</Button
			>
		{/if}
		<Button variant="ghost" disabled={batchBusy} onclick={onclear}>Clear</Button
		>
	</div>
{/if}
