<script lang="ts">
	import type { DashboardFile } from '@adrive/shared';
	import CopyButton from '$lib/components/ui/CopyButton.svelte';
	import Menu from '$lib/components/ui/Menu.svelte';

	let {
		file,
		trashed,
		onopen,
		oncopy,
		ontrash,
		onrestore,
		onpurge
	}: {
		file: DashboardFile;
		trashed: boolean;
		onopen: () => void;
		oncopy: () => string | Promise<string>;
		ontrash: () => void;
		onrestore: () => void;
		onpurge?: () => void;
	} = $props();

	const itemClass =
		'block w-full rounded-md px-3 py-2 text-left text-sm text-zinc-700 hover:bg-zinc-50 focus:bg-zinc-50 focus:outline-none disabled:pointer-events-none disabled:opacity-40';
</script>

<Menu label={`Actions for ${file.displayName}`}>
	{#if trashed}
		<button role="menuitem" type="button" class={itemClass} onclick={onrestore}>
			Restore
		</button>
		{#if onpurge}
			<button
				role="menuitem"
				type="button"
				class="{itemClass} text-red-700 hover:bg-red-50"
				onclick={onpurge}>Delete permanently</button
			>
		{/if}
	{:else}
		<button
			role="menuitem"
			type="button"
			class={itemClass}
			disabled={file.quarantined}
			onclick={onopen}
		>
			{file.public || file.kind === 'site' ? 'Open' : 'Download'}
		</button>
		<CopyButton
			variant="menu"
			role="menuitem"
			data-keep-open
			label={file.public ? 'Copy link' : 'Copy temporary link'}
			resolve={oncopy}
			disabled={file.quarantined}
		/>
		<button
			role="menuitem"
			type="button"
			class="{itemClass} text-red-700 hover:bg-red-50"
			onclick={ontrash}>Move to trash</button
		>
	{/if}
</Menu>
