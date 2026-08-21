<script lang="ts">
	import Button from '$lib/components/ui/Button.svelte';
	import Icon from '$lib/components/ui/Icon.svelte';

	let {
		showTrash,
		filesCount,
		uploadsAvailable,
		onview,
		onupload,
		onemptytrash
	}: {
		showTrash: boolean;
		filesCount: number;
		uploadsAvailable: boolean;
		onview: (view: 'files' | 'trash') => void;
		onupload: () => void;
		onemptytrash: () => void;
	} = $props();
</script>

<header class="flex items-center justify-between gap-4">
	<div class="inline-flex rounded-lg bg-zinc-100 p-1">
		<button
			type="button"
			aria-pressed={!showTrash}
			class="rounded-md px-3 py-1.5 text-sm font-medium {!showTrash
				? 'bg-white text-zinc-950 shadow-sm'
				: 'text-zinc-500'}"
			onclick={() => onview('files')}>Files</button
		>
		<button
			type="button"
			aria-pressed={showTrash}
			class="rounded-md px-3 py-1.5 text-sm font-medium {showTrash
				? 'bg-white text-zinc-950 shadow-sm'
				: 'text-zinc-500'}"
			onclick={() => onview('trash')}>Trash</button
		>
	</div>
	{#if !showTrash}
		<Button disabled={!uploadsAvailable} onclick={onupload}>
			<Icon name="plus" />
			Upload
		</Button>
	{:else if filesCount > 0}
		<Button variant="danger" onclick={onemptytrash}>Empty trash</Button>
	{/if}
</header>
