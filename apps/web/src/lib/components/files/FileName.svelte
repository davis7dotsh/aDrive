<script lang="ts">
	import type { DashboardFile } from '@adrive/shared';
	import type { Attachment } from 'svelte/attachments';

	let {
		file,
		busy,
		onrename
	}: {
		file: DashboardFile;
		busy: boolean;
		onrename: (name: string) => void;
	} = $props();

	let editing = $state(false);
	let name = $derived(file.displayName);
	let input = $state<HTMLInputElement>();
	const attachInput: Attachment<HTMLInputElement> = (node) => {
		input = node;
		return () => {
			if (input === node) input = undefined;
		};
	};

	const save = () => {
		const next = name.trim();
		editing = false;
		if (next && next !== file.displayName) {
			onrename(next);
		} else {
			name = file.displayName;
		}
	};
</script>

{#if editing}
	<input
		{@attach attachInput}
		aria-label="File name"
		bind:value={name}
		disabled={busy}
		class="min-w-0 flex-1 rounded-md border border-zinc-300 px-2 py-1 text-xl font-semibold tracking-tight text-zinc-950"
		onblur={save}
		onkeydown={(event) => {
			if (event.key === 'Enter') {
				event.preventDefault();
				event.currentTarget.blur();
			} else if (event.key === 'Escape') {
				name = file.displayName;
				editing = false;
			}
		}}
	/>
{:else}
	<button
		type="button"
		class="min-w-0 truncate rounded px-2 py-1 text-left text-xl font-semibold tracking-tight text-zinc-950 hover:bg-zinc-100"
		title="Rename file"
		onclick={() => {
			name = file.displayName;
			editing = true;
			queueMicrotask(() => input?.focus());
		}}>{file.displayName}</button
	>
{/if}
